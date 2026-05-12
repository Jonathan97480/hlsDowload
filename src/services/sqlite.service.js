const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.resolve(__dirname, "../../data");
const DB_FILE = path.join(DATA_DIR, "app.db");
const LEGACY_STATE_FILE = path.join(DATA_DIR, "admin-state.json");

let db = null;

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createSchema(database) {
    database.pragma("journal_mode = WAL");
    database.exec(`
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            username TEXT NOT NULL,
            email TEXT DEFAULT '',
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value_text TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_json TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS setup_tokens (
            token TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
            job_id TEXT PRIMARY KEY,
            request_key TEXT DEFAULT '',
            url TEXT NOT NULL,
            preferred_name TEXT DEFAULT '',
            headers_json TEXT DEFAULT '{}',
            status TEXT NOT NULL,
            progress INTEGER DEFAULT 0,
            timemark TEXT DEFAULT '',
            message TEXT DEFAULT '',
            file_name TEXT DEFAULT '',
            file_path TEXT DEFAULT '',
            file_size_bytes INTEGER DEFAULT 0,
            source_ip TEXT DEFAULT '',
            client_id TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            started_at INTEGER DEFAULT 0,
            completed_at INTEGER DEFAULT 0,
            duration_ms INTEGER DEFAULT 0,
            error TEXT DEFAULT '',
            updated_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_request_status ON jobs(request_key, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
}

function upsertState(database, key, valueText) {
    database.prepare(`
        INSERT INTO app_state (key, value_text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_text = excluded.value_text,
            updated_at = excluded.updated_at
    `).run(key, valueText, Date.now());
}

function seedDefaults(database) {
    const now = Date.now();
    const hasSettings = database.prepare("SELECT 1 FROM app_state WHERE key = ?").get("settings_json");
    if (!hasSettings) {
        upsertState(database, "settings_json", JSON.stringify({ maxConcurrentDownloads: 3 }));
    }

    const hasApiKey = database.prepare("SELECT 1 FROM app_state WHERE key = ?").get("api_key");
    if (!hasApiKey && process.env.API_KEY) {
        upsertState(database, "api_key", process.env.API_KEY);
    }

    const hasMigrationMark = database.prepare("SELECT 1 FROM app_state WHERE key = ?").get("legacy_migration_done");
    if (!hasMigrationMark) {
        maybeMigrateLegacyJson(database);
        upsertState(database, "legacy_migration_done", String(now));
    }
}

function maybeMigrateLegacyJson(database) {
    if (!fs.existsSync(LEGACY_STATE_FILE)) {
        return;
    }

    let legacy = null;
    try {
        legacy = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, "utf8"));
    } catch (_error) {
        return;
    }

    const tx = database.transaction(() => {
        const now = Date.now();

        if (legacy?.admin && !database.prepare("SELECT 1 FROM admins WHERE id = 1").get()) {
            database.prepare(`
                INSERT INTO admins (id, username, email, password_hash, created_at, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)
            `).run(
                String(legacy.admin.username || "admin"),
                String(legacy.admin.email || ""),
                String(legacy.admin.passwordHash || ""),
                Date.parse(legacy.admin.createdAt || "") || now,
                Date.parse(legacy.admin.updatedAt || "") || now
            );
        }

        if (legacy?.apiKey) {
            upsertState(database, "api_key", String(legacy.apiKey));
        }

        if (legacy?.settings && typeof legacy.settings === "object") {
            upsertState(database, "settings_json", JSON.stringify(legacy.settings));
        }

        if (legacy?.setupToken?.token) {
            database.prepare("INSERT OR REPLACE INTO setup_tokens (token, expires_at, created_at) VALUES (?, ?, ?)")
                .run(
                    String(legacy.setupToken.token),
                    Number(legacy.setupToken.expiresAt || 0),
                    now
                );
        }

        if (legacy?.sessions && typeof legacy.sessions === "object") {
            const insertSession = database.prepare(`
                INSERT OR REPLACE INTO sessions (token, user_json, expires_at, created_at)
                VALUES (?, ?, ?, ?)
            `);

            for (const [token, session] of Object.entries(legacy.sessions)) {
                if (!token || !session?.expiresAt) {
                    continue;
                }

                insertSession.run(
                    token,
                    JSON.stringify(session.user || {}),
                    Number(session.expiresAt || 0),
                    now
                );
            }
        }
    });

    tx();
}

function getDb() {
    if (db) {
        return db;
    }

    ensureDataDir();
    db = new Database(DB_FILE);
    createSchema(db);
    seedDefaults(db);
    return db;
}

module.exports = {
    getDb
};
