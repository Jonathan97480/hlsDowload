const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
const { getBestHlsUrl } = require("./hls-quality.service");
const { findMasterM3U8 } = require("./master-detector.service");
const { ensureDownloadsDir, createSafeOutputName } = require("./file-output.service");

if (process.env.FFMPEG_PATH) {
    ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

function buildInputOptions(headers) {
    const options = [];

    // Improve resilience against temporary CDN/network instability.
    options.push("-rw_timeout");
    options.push("15000000");
    options.push("-reconnect");
    options.push("1");
    options.push("-reconnect_streamed");
    options.push("1");
    options.push("-reconnect_delay_max");
    options.push("10");

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

function runFfmpegConvert(finalUrl, inputOptions, outputPath, hooks, mode) {
    const isTranscode = mode === "transcode";

    return new Promise((resolve, reject) => {
        const command = ffmpeg(finalUrl);

        if (inputOptions.length > 0) {
            command.inputOptions(inputOptions);
        }

        const outputOptions = isTranscode
            ? [
                "-c:v libx264",
                "-preset veryfast",
                "-crf 22",
                "-pix_fmt yuv420p",
                "-c:a aac",
                "-b:a 128k",
                "-movflags +faststart"
            ]
            : [
                "-c copy",
                "-bsf:a aac_adtstoasc",
                "-movflags +faststart"
            ];

        command
            .outputOptions(outputOptions)
            .format("mp4")
            .on("start", () => {
                console.log(`[ffmpeg] FFmpeg demarree (${mode})`);
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
                resolve();
            })
            .on("error", (error) => {
                reject(new Error(`Echec FFmpeg (${mode}): ${error.message}`));
            })
            .save(outputPath);
    });
}

function validateWithFfprobe(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (error, metadata) => {
            if (error) {
                reject(new Error(`ffprobe indisponible: ${error.message}`));
                return;
            }

            const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
            const hasVideo = streams.some((stream) => stream.codec_type === "video");

            if (!hasVideo) {
                reject(new Error("Aucun flux video detecte dans le MP4"));
                return;
            }

            resolve();
        });
    });
}

function validateDecodePass(filePath) {
    return new Promise((resolve, reject) => {
        const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
        const args = ["-v", "error", "-i", filePath, "-t", "120", "-f", "null", "-"];
        const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            reject(new Error(`Validation ffmpeg impossible: ${error.message}`));
        });

        child.on("close", (code) => {
            if (code === 0 && !stderr.trim()) {
                resolve();
                return;
            }

            reject(new Error(`Decode check en echec: ${stderr.trim() || `exit ${code}`}`));
        });
    });
}

async function validateOutputFile(outputPath) {
    await validateWithFfprobe(outputPath);
    await validateDecodePass(outputPath);
}

function removeOutputIfExists(outputPath) {
    try {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
    } catch (_error) {
        // Ignore delete errors before fallback transcode.
    }
}

function downloadHlsToMp4(sourceUrl, headers = {}, hooks = {}, options = {}) {
    const downloadsDir = ensureDownloadsDir();
    const parsedMaxTitleLength = Number.parseInt(options.maxTitleLength, 10);
    const maxTitleLength = Number.isFinite(parsedMaxTitleLength)
        ? Math.min(500, Math.max(50, parsedMaxTitleLength))
        : 500;
    const outputFileName = createSafeOutputName(downloadsDir, options.preferredName || "", maxTitleLength);
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
            console.log("[ffmpeg] Demarrage FFmpeg en mode copy...");

            return runFfmpegConvert(finalUrl, inputOptions, outputPath, hooks, "copy")
                .then(() => validateOutputFile(outputPath))
                .catch((error) => {
                    console.log(`[ffmpeg] Copy invalide/instable: ${error.message}`);
                    console.log("[ffmpeg] Relance en mode transcodage robuste...");
                    removeOutputIfExists(outputPath);

                    return runFfmpegConvert(finalUrl, inputOptions, outputPath, hooks, "transcode")
                        .then(() => validateOutputFile(outputPath))
                        .then(() => ({ mode: "transcode" }));
                })
                .then((fallbackResult) => {
                    const mode = fallbackResult?.mode || "copy";
                    console.log(`[ffmpeg] FFmpeg terminee avec succes - qualite finale: ${quality} - mode: ${mode}`);

                    return {
                        outputFileName,
                        outputPath,
                        quality,
                        mode
                    };
                });
        });
}

module.exports = {
    downloadHlsToMp4
};
