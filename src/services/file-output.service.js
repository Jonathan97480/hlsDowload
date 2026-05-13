const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

function ensureDownloadsDir() {
    const dirPath = path.resolve(__dirname, "../../downloads");

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    return dirPath;
}

function sanitizeBaseName(input, maxLength = 500) {
    if (typeof input !== "string") {
        return "";
    }

    const noExtension = input.replace(/\.mp4$/i, "").trim();
    const normalized = noExtension
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const compact = normalized.replace(/[^a-zA-Z0-9 _.-]/g, "").trim();

    if (!compact) {
        return "";
    }

    return compact.slice(0, maxLength);
}

function createSafeOutputName(downloadsDir, preferredName = "", maxLength = 500) {
    const safeBaseName = sanitizeBaseName(preferredName, maxLength) || uuidv4();
    let outputFileName = `${safeBaseName}.mp4`;
    let index = 2;

    while (fs.existsSync(path.join(downloadsDir, outputFileName))) {
        outputFileName = `${safeBaseName}-${index}.mp4`;
        index += 1;
    }

    return outputFileName;
}

module.exports = {
    ensureDownloadsDir,
    sanitizeBaseName,
    createSafeOutputName
};
