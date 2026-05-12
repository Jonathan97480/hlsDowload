const fs = require("fs");
const path = require("path");

const DOWNLOADS_DIR = path.resolve(__dirname, "../../downloads");
const DEFAULT_MIN_FREE_PERCENT = 5;

function ensureDownloadsDir() {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

function getMinFreePercent() {
    const raw = Number.parseFloat(process.env.DISK_MIN_FREE_PERCENT || "");

    if (!Number.isFinite(raw)) {
        return DEFAULT_MIN_FREE_PERCENT;
    }

    return Math.min(50, Math.max(1, raw));
}

function getDiskSnapshot() {
    try {
        const stats = fs.statfsSync(DOWNLOADS_DIR);
        const totalBytes = Number(stats.blocks || 0) * Number(stats.bsize || 0);
        const freeBytes = Number(stats.bavail || 0) * Number(stats.bsize || 0);
        const freePercent = totalBytes > 0 ? Number(((freeBytes / totalBytes) * 100).toFixed(2)) : 100;

        return {
            totalBytes,
            freeBytes,
            freePercent
        };
    } catch (_error) {
        return null;
    }
}

function listOldestDownloadFiles() {
    let entries = [];

    try {
        entries = fs.readdirSync(DOWNLOADS_DIR);
    } catch (_error) {
        return [];
    }

    const files = [];

    for (const entry of entries) {
        if (!entry.toLowerCase().endsWith(".mp4")) {
            continue;
        }

        const filePath = path.join(DOWNLOADS_DIR, entry);

        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                continue;
            }

            files.push({
                fileName: entry,
                filePath,
                mtimeMs: stat.mtimeMs,
                sizeBytes: stat.size
            });
        } catch (_error) {
            // Ignore race conditions on concurrent file operations.
        }
    }

    return files.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function ensureDiskSpaceForDownload() {
    ensureDownloadsDir();

    const minFreePercent = getMinFreePercent();
    const before = getDiskSnapshot();

    if (!before) {
        return {
            ok: true,
            skipped: true,
            message: "Controle disque indisponible sur cette plateforme."
        };
    }

    if (before.freePercent > minFreePercent) {
        return {
            ok: true,
            minFreePercent,
            before,
            after: before,
            deletedFiles: []
        };
    }

    const deletedFiles = [];
    const candidates = listOldestDownloadFiles();

    for (const file of candidates) {
        try {
            fs.unlinkSync(file.filePath);
            deletedFiles.push(file);
            console.log(`[storage-guard] Suppression pour liberer de la place: ${file.fileName}`);
        } catch (error) {
            console.error(`[storage-guard] Echec suppression ${file.fileName}: ${error.message}`);
        }

        const current = getDiskSnapshot();
        if (current && current.freePercent > minFreePercent) {
            return {
                ok: true,
                minFreePercent,
                before,
                after: current,
                deletedFiles
            };
        }
    }

    const after = getDiskSnapshot() || before;

    return {
        ok: after.freePercent > minFreePercent,
        minFreePercent,
        before,
        after,
        deletedFiles,
        message: "Espace disque insuffisant apres purge des fichiers les plus anciens."
    };
}

module.exports = {
    ensureDiskSpaceForDownload
};
