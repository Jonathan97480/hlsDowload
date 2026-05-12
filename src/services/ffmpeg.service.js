const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const { getBestHlsUrl } = require("./hls-quality.service");
const { findMasterM3U8 } = require("./master-detector.service");

if (process.env.FFMPEG_PATH) {
    ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

function ensureDownloadsDir() {
    const dirPath = path.resolve(__dirname, "../../downloads");

    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    return dirPath;
}

function sanitizeBaseName(input) {
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

    return compact.slice(0, 100);
}

function createSafeOutputName(downloadsDir, preferredName = "") {
    const safeBaseName = sanitizeBaseName(preferredName) || uuidv4();
    let outputFileName = `${safeBaseName}.mp4`;
    let index = 2;

    while (fs.existsSync(path.join(downloadsDir, outputFileName))) {
        outputFileName = `${safeBaseName}-${index}.mp4`;
        index += 1;
    }

    return outputFileName;
}

function buildInputOptions(headers) {
    const options = [];

    if (headers?.referer) {
        options.push("-referer");
        options.push(headers.referer);
    }

    if (headers?.userAgent) {
        options.push("-user_agent");
        options.push(headers.userAgent);
    }

    if (headers?.cookie) {
        options.push("-headers");
        options.push(`Cookie: ${headers.cookie}\\r\\n`);
    }

    return options;
}

function downloadHlsToMp4(sourceUrl, headers = {}, hooks = {}, options = {}) {
    const downloadsDir = ensureDownloadsDir();
    const outputFileName = createSafeOutputName(downloadsDir, options.preferredName || "");
    const outputPath = path.join(downloadsDir, outputFileName);
    const inputOptions = buildInputOptions(headers);

    // Étape 1: Tenter de trouver le master M3U8
    // Convertir headers du format FFmpeg vers format HTTP
    const httpHeaders = {};
    if (headers?.referer) httpHeaders["Referer"] = headers.referer;
    if (headers?.userAgent) httpHeaders["User-Agent"] = headers.userAgent;
    if (headers?.cookie) httpHeaders["Cookie"] = headers.cookie;

    return findMasterM3U8(sourceUrl, httpHeaders)
        .then((masterResult) => {
            console.log(`[ffmpeg] ====== NOUVELLE CONVERSION ======`);
            console.log(`[ffmpeg] URL source: ${sourceUrl}`);
            console.log(`[ffmpeg] Master detection: ${masterResult.method} (${masterResult.isMaster ? "✅ master" : "⚠️ non-master"})`);

            // Étape 2: Analyser la meilleure qualité
            return getBestHlsUrl(masterResult.url, httpHeaders).then((qualityInfo) => ({
                ...qualityInfo,
                masterMethod: masterResult.method,
                isMaster: masterResult.isMaster
            }));
        })
        .then((qualityInfo) => {
            const finalUrl = qualityInfo.bestUrl || sourceUrl;
            const quality = qualityInfo.quality || "unknown";
            const isFallback = qualityInfo.quality === "fallback" || qualityInfo.quality === "unknown";

            if (isFallback && !qualityInfo.isMaster) {
                console.log(`[ffmpeg] ⚠️  AVERTISSEMENT: URL non-master et qualité non déterminée`);
            }
            console.log(`[ffmpeg] Qualite: ${quality}`);
            console.log(`[ffmpeg] URL finale: ${finalUrl}`);
            console.log(`[ffmpeg] Demarrage FFmpeg...`);

            return new Promise((resolve, reject) => {
                const command = ffmpeg(finalUrl);

                if (inputOptions.length > 0) {
                    command.inputOptions(inputOptions);
                }

                command
                    .outputOptions(["-c copy", "-bsf:a aac_adtstoasc"])
                    .format("mp4")
                    .on("start", () => {
                        console.log(`[ffmpeg] FFmpeg demarrée`);
                        if (typeof hooks.onStart === "function") {
                            hooks.onStart();
                        }
                    })
                    .on("progress", (progress) => {
                        if (typeof hooks.onProgress === "function") {
                            hooks.onProgress(progress || {});
                        }
                    })
                    .on("end", () => {
                        console.log(`[ffmpeg] FFmpeg terminée avec succes - qualite finale: ${quality}`);
                        resolve({
                            outputFileName,
                            outputPath,
                            quality
                        });
                    })
                    .on("error", (error) => {
                        console.log(`[ffmpeg] ERREUR FFmpeg: ${error.message}`);
                        reject(new Error(`Echec FFmpeg: ${error.message}`));
                    })
                    .save(outputPath);
            });
        });
}

module.exports = {
    downloadHlsToMp4
};
