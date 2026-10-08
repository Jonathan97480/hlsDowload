const crypto = require("crypto");
const { getDb } = require("./src/services/sqlite.service");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const digest = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
    return `${salt}:${digest}`;
}

const db = getDb();
const username = process.argv[2] || process.env.ADMIN_DEFAULT_USERNAME || "admin";
const password = process.argv[3] || process.env.ADMIN_DEFAULT_PASSWORD || "admin123";
const hash = hashPassword(password);
const now = Date.now();

// Clean expired/old sessions
db.prepare("DELETE FROM sessions").run();
db.prepare("DELETE FROM setup_tokens").run();

// Upsert admin row
db.prepare(`
    INSERT INTO admins (id, username, email, password_hash, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at
`).run(username, "", hash, now, now);

const row = db.prepare("SELECT id, username, email, updated_at FROM admins WHERE id = 1").get();
console.log("SUCCESS:", JSON.stringify(row));
