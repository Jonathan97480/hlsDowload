const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { getBestHlsUrl } = require("./hls-quality.service");
const { findMasterM3U8 } = require("./master-detector.service");
const { ensureDownloadsDir, createSafeOutputName } = require("./file-output.service");
const { createSegmentDownloadTask } = require("./hls-segment-pipeline.service");
const {
    buildCopyOutputOptions,
    buildStableTranscodeOutputOptions
} = require("./ffmpeg-output-options.service");
const { validateOutputFile, verifySegmentIntegrity } = require("./video-validation.service");

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
            ? buildStableTranscodeOutputOptions()
            : buildCopyOutputOptions();

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

function removeOutputIfExists(outputPath) {
    try {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
    } catch (_error) {
        // Ignore delete errors before fallback transcode.
    }
}

function createCancelledError() {
    return new Error("Telechargement annule");
}

function createHttpHeaders(headers) {
    const httpHeaders = {};

    if (headers?.referer) httpHeaders.Referer = headers.referer;
    if (headers?.userAgent) httpHeaders["User-Agent"] = headers.userAgent;
    if (headers?.cookie) httpHeaders.Cookie = headers.cookie;

    return httpHeaders;
}

function runFfmpegConvertTask(finalUrl, inputOptions, outputPath, hooks, mode) {
    const isTranscode = mode === "transcode";
    let command = null;
    let settled = false;
    let cancelled = false;

    const promise = new Promise((resolve, reject) => {
        function safeResolve(value) {
            if (settled) return;
            settled = true;
            resolve(value);
        }

        function safeReject(error) {
            if (settled) return;
            settled = true;
            reject(error);
        }

        command = ffmpeg(finalUrl);

        if (inputOptions.length > 0) {
            command.inputOptions(inputOptions);
        }

        const outputOptions = isTranscode
            ? buildStableTranscodeOutputOptions()
            : buildCopyOutputOptions();

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
                if (cancelled) {
                    removeOutputIfExists(outputPath);
                    safeReject(createCancelledError());
                    return;
                }
                safeResolve();
            })
            .on("error", (error) => {
                if (cancelled) {
                    removeOutputIfExists(outputPath);
                    safeReject(createCancelledError());
                    return;
                }
                safeReject(new Error(`Echec FFmpeg (${mode}): ${error.message}`));
            })
            .save(outputPath);
    });

    return {
        promise,
        cancel: () => {
            if (settled || cancelled) return false;
            cancelled = true;
            try {
                if (command && typeof command.kill === "function") {
                    command.kill("SIGKILL");
                }
            } catch (_error) { }
            removeOutputIfExists(outputPath);
            return true;
        }
    };
}

function downloadHlsToMp4(sourceUrl, headers = {}, hooks = {}, options = {}) {
    return createHlsDownloadTask(sourceUrl, headers, hooks, options).promise;
}

function createHlsDownloadTask(sourceUrl, headers = {}, hooks = {}, options = {}) {
    const downloadsDir = ensureDownloadsDir();
    const parsedMaxTitleLength = Number.parseInt(options.maxTitleLength, 10);
    const maxTitleLength = Number.isFinite(parsedMaxTitleLength)
        ? Math.min(500, Math.max(50, parsedMaxTitleLength))
        : 500;
    const outputFileName = createSafeOutputName(downloadsDir, options.preferredName || "", maxTitleLength);
    const outputPath = path.join(downloadsDir, outputFileName);
    const inputOptions = buildInputOptions(headers);

    const httpHeaders = createHttpHeaders(headers);

    let currentTask = null;
    let cancelled = false;
    const cancel = () => {
        cancelled = true;
        if (currentTask && typeof currentTask.cancel === "function") {
            currentTask.cancel();
        }
        removeOutputIfExists(outputPath);
        return true;
    };

    const promise = findMasterM3U8(sourceUrl, httpHeaders)
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

            console.log("[ffmpeg] Tentative 1: pipeline segments HLS...");
            currentTask = createSegmentDownloadTask(finalUrl, headers, outputPath, hooks);
            return currentTask.promise
                .then((segmentResult) => {
                    console.log(`[ffmpeg] Pipeline segments a renvoye: ${JSON.stringify(segmentResult || {})}`);
                    const mode = segmentResult?.mode || "transcode";
                    console.log(`[ffmpeg] Conversion segments terminee - qualite finale: ${quality} - mode: ${mode}`);

                    return {
                        outputFileName,
                        outputPath,
                        quality,
                        mode
                    };
                })
                .catch((segmentError) => {
                    if (cancelled || segmentError.message === "Telechargement annule") {
                        throw createCancelledError();
                    }

                    console.log(`[ffmpeg] Pipeline segments indisponible: ${segmentError.message}`);
                    console.log("[ffmpeg] Tentative 2: pipeline FFmpeg classique en mode transcode stable...");
                    removeOutputIfExists(outputPath);

                    currentTask = runFfmpegConvertTask(finalUrl, inputOptions, outputPath, hooks, "transcode");
                    return currentTask.promise
                        .then(() => {
                            if (cancelled) throw createCancelledError();
                            return validateOutputFile(outputPath);
                        })
                        .then(() => ({ mode: "transcode" }))
                        .then((fallbackResult) => {
                            const mode = fallbackResult?.mode || "transcode";
                            console.log(`[ffmpeg] FFmpeg terminee avec succes - qualite finale: ${quality} - mode: ${mode}`);

                            return {
                                outputFileName,
                                outputPath,
                                quality,
                                mode
                            };
                        });
                });
        });

    return {
        promise,
        cancel
    };
}

module.exports = {
    createHlsDownloadTask,
    downloadHlsToMp4,
    verifySegmentIntegrity
};
