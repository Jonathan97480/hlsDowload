const fs = require("fs");
const path = require("path");

const DOWNLOADS_DIR = path.resolve(__dirname, "../../downloads");
const MAX_AGE_MS = 60 * 60 * 1000; // 1 heure

function deleteOldFiles() {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        return;
    }

    const now = Date.now();
    let entries;

    try {
        entries = fs.readdirSync(DOWNLOADS_DIR);
    } catch (err) {
        console.error("[cleanup] Impossible de lire le dossier downloads:", err.message);
        return;
    }

    for (const entry of entries) {
        if (!entry.endsWith(".mp4")) {
            continue;
        }

        const filePath = path.join(DOWNLOADS_DIR, entry);

        try {
            const stat = fs.statSync(filePath);
            const age = now - stat.mtimeMs;

            if (age >= MAX_AGE_MS) {
                fs.unlinkSync(filePath);
                console.log(`[cleanup] Fichier supprime (${Math.floor(age / 60000)} min): ${entry}`);
            }
        } catch (err) {
            console.error(`[cleanup] Erreur sur le fichier ${entry}:`, err.message);
        }
    }
}

function startCleanupSchedule() {
    // Premier passage au démarrage pour supprimer les fichiers déjà trop anciens
    deleteOldFiles();

    // Puis toutes les heures
    setInterval(deleteOldFiles, MAX_AGE_MS);
    console.log("[cleanup] Nettoyage automatique active (intervalle: 1h)");
}

module.exports = { startCleanupSchedule };
