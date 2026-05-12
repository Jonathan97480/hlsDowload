const crypto = require("crypto");
const { getDb } = require("./sqlite.service");

const db = getDb();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ADMIN_USERNAME = process.env.ADMIN_DEFAULT_USERNAME || "admin";
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || "admin123";

function parseJson(value, fallback) {
    if (typeof value !== "string" || !value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
}

function getStateValue(key, fallback = "") {
    const row = db.prepare("SELECT value_text FROM app_state WHERE key = ?").get(key);
    return row ? row.value_text : fallback;
}

function setStateValue(key, valueText) {
    db.prepare(`
        INSERT INTO app_state (key, value_text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_text = excluded.value_text,
            updated_at = excluded.updated_at
    `).run(key, valueText, Date.now());
}

function getAdminRow() {
    return db.prepare("SELECT * FROM admins WHERE id = 1").get();
}

function pruneExpiredSessions() {
    const now = Date.now();
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM setup_tokens WHERE expires_at <= ?").run(now);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const digest = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
    return `${salt}:${digest}`;
}

function verifyPassword(password, storedHash) {
    if (!password || !storedHash || typeof storedHash !== "string") {
        return false;
    }

    const [salt, digest] = storedHash.split(":");
    if (!salt || !digest) {
        return false;
    }

    const nextDigest = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
    return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(nextDigest, "hex"));
}

function generateToken() {
    return crypto.randomUUID();
}

function getActiveApiKey() {
    return getStateValue("api_key", process.env.API_KEY || "");
}

function setActiveApiKey(apiKey) {
    setStateValue("api_key", String(apiKey || ""));
    return apiKey;
}

function refreshState() {
    pruneExpiredSessions();
    const admin = getAdminProfile();
    const settings = getSettings();

    return {
        admin,
        settings,
        apiKey: getActiveApiKey()
    };
}

function getBootstrapInfo() {
    pruneExpiredSessions();

    return {
        setupRequired: !getAdminRow(),
        defaultUsername: DEFAULT_ADMIN_USERNAME,
        hasApiKey: Boolean(getActiveApiKey())
    };
}

function createSetupToken() {
    pruneExpiredSessions();
    const token = generateToken();
    db.prepare("DELETE FROM setup_tokens").run();
    db.prepare("INSERT INTO setup_tokens (token, expires_at, created_at) VALUES (?, ?, ?)")
        .run(token, Date.now() + SETUP_TTL_MS, Date.now());
    return token;
}

function validateSetupToken(token) {
    pruneExpiredSessions();
    if (!token) {
        return false;
    }

    const row = db.prepare("SELECT token FROM setup_tokens WHERE token = ? AND expires_at > ?")
        .get(token, Date.now());
    return Boolean(row);
}

function clearSetupToken() {
    db.prepare("DELETE FROM setup_tokens").run();
}

function validatePasswordStrength(password) {
    if (typeof password !== "string" || password.length < 10) {
        return "Le mot de passe doit contenir au moins 10 caracteres.";
    }

    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return "Le mot de passe doit contenir des minuscules, des majuscules et des chiffres.";
    }

    return "";
}

function normalizeUsername(username) {
    return typeof username === "string" ? username.trim().slice(0, 80) : "";
}

function normalizeEmail(email) {
    return typeof email === "string" ? email.trim().slice(0, 120) : "";
}

function getAdminProfile() {
    pruneExpiredSessions();
    const row = getAdminRow();

    if (!row) {
        return null;
    }

    return {
        username: row.username,
        email: row.email || ""
    };
}

function setInitialAdmin({ username, password, email }) {
    pruneExpiredSessions();
    const normalizedUsername = normalizeUsername(username);
    const normalizedEmail = normalizeEmail(email);
    const strengthError = validatePasswordStrength(password);

    if (!normalizedUsername) {
        throw new Error("Le pseudo administrateur est requis.");
    }

    if (strengthError) {
        throw new Error(strengthError);
    }

    const now = Date.now();
    db.prepare(`
        INSERT INTO admins (id, username, email, password_hash, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            username = excluded.username,
            email = excluded.email,
            password_hash = excluded.password_hash,
            updated_at = excluded.updated_at
    `).run(normalizedUsername, normalizedEmail, hashPassword(password), now, now);

    clearSetupToken();

    return getAdminProfile();
}

function authenticateAdmin({ username, password }) {
    pruneExpiredSessions();
    const admin = getAdminRow();

    if (!admin) {
        if (String(password || "") !== DEFAULT_ADMIN_PASSWORD) {
            return { ok: false, error: "Mot de passe de configuration invalide." };
        }

        return {
            ok: true,
            requiresSetup: true,
            setupToken: createSetupToken()
        };
    }

    if (normalizeUsername(username) !== admin.username) {
        return { ok: false, error: "Identifiants invalides." };
    }

    if (!verifyPassword(password, admin.password_hash)) {
        return { ok: false, error: "Identifiants invalides." };
    }

    return {
        ok: true,
        requiresSetup: false,
        user: getAdminProfile()
    };
}

function createSession(user) {
    pruneExpiredSessions();
    const token = generateToken();
    db.prepare(`
        INSERT INTO sessions (token, user_json, expires_at, created_at)
        VALUES (?, ?, ?, ?)
    `).run(token, JSON.stringify(user || {}), Date.now() + SESSION_TTL_MS, Date.now());

    return {
        token,
        user
    };
}

function getSession(token) {
    if (!token) {
        return null;
    }

    pruneExpiredSessions();
    const row = db.prepare("SELECT user_json, expires_at FROM sessions WHERE token = ?").get(token);
    if (!row || row.expires_at <= Date.now()) {
        return null;
    }

    return {
        token,
        user: parseJson(row.user_json, {})
    };
}

function revokeSession(token) {
    if (!token) {
        return;
    }

    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

function getSettings() {
    pruneExpiredSessions();
    const parsed = parseJson(getStateValue("settings_json", ""), { maxConcurrentDownloads: 3 });
    const raw = Number.parseInt(parsed.maxConcurrentDownloads, 10);

    return {
        maxConcurrentDownloads: Number.isFinite(raw) ? Math.min(12, Math.max(1, raw)) : 3
    };
}

function updateSettings(patch = {}) {
    const nextValue = Number.parseInt(patch.maxConcurrentDownloads, 10);
    const current = getSettings();
    const nextSettings = {
        ...current,
        maxConcurrentDownloads: Number.isFinite(nextValue) ? Math.min(12, Math.max(1, nextValue)) : current.maxConcurrentDownloads
    };

    setStateValue("settings_json", JSON.stringify(nextSettings));
    return nextSettings;
}

function generateApiKey() {
    return crypto.randomUUID();
}

function rotateApiKey() {
    const apiKey = generateApiKey();
    setActiveApiKey(apiKey);
    return apiKey;
}

module.exports = {
    authenticateAdmin,
    clearSetupToken,
    createSession,
    getActiveApiKey,
    getAdminProfile,
    getBootstrapInfo,
    getSettings,
    getSession,
    refreshState,
    revokeSession,
    rotateApiKey,
    setActiveApiKey,
    setInitialAdmin,
    updateSettings,
    validateSetupToken
};