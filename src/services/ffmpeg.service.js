const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const { getBestHlsUrl } = require("./hls-quality.service");
const { findMasterM3U8 } = require("./master-detector.service");
const { ensureDownloadsDir, createSafeOutputName } = require("./file-output.service");
const { createSegmentDownloadTask } = require("./hls-segment-pipeline.service");
const {
    buildCopyOutputOptions,
    buildStableTranscodeOutputOptions,
    buildVideoTranscodeCopyAudioOutputOptions
} = require("./ffmpeg-output-options.service");
const { validateOutputFile, verifySegmentIntegrity } = require("./video-validation.service");

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

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

function normalizeFfmpegMode(modeOrOptions) {
    if (typeof modeOrOptions === "string") {
        return { mode: modeOrOptions, syncProfile: "soft" };
    }
    return { mode: modeOrOptions?.mode || "transcode", syncProfile: modeOrOptions?.syncProfile || "soft" };
}

function buildEffectiveAudioStrategy(mode, syncProfile) {
    if (mode === "copy") return "copy-source";
    if (mode === "direct") return "copy-source";
    if (mode === "transcode-copy-audio") return "copy-source";
    if (mode === "yt-dlp") return "yt-dlp";
    if (mode === "transcode") return `transcode-${syncProfile || "soft"}`;
    return "";
}
function runValidatedFfmpegFallback(finalUrl, inputOptions, outputPath, hooks, cancelledRef, options = {}) {
    const syncProfile = options.syncProfile || "soft";
    const preferAudioCopy = options.preferAudioCopy !== false;
    removeOutputIfExists(outputPath);

    let task = null;
    const runAttempt = (mode, logMessage) => {
        console.log(logMessage);
        task = runFfmpegConvertTask(finalUrl, inputOptions, outputPath, hooks, { mode, syncProfile });
        return task.promise
            .then(() => {
                if (cancelledRef.cancelled) throw createCancelledError();
                return validateOutputFile(outputPath);
            })
            .then(() => ({ mode, effectiveAudioStrategy: buildEffectiveAudioStrategy(mode, syncProfile) }));
    };

    // On privilegie le transcode audio complet sur les flux HLS sensibles au drift.
    const attempts = preferAudioCopy
        ? [
            {
                mode: "transcode-copy-audio",
                logMessage: "[ffmpeg] Tentative 2: transcode video + copie audio..."
            },
            {
                mode: "transcode",
                logMessage: "[ffmpeg] Tentative 3: transcode complet avec profil audio tres doux...",
                failureLabel: "Copie audio impossible"
            }
        ]
        : [
            {
                mode: "transcode",
                logMessage: "[ffmpeg] Tentative 2: transcode complet avec profil audio tres doux..."
            },
            {
                mode: "transcode-copy-audio",
                logMessage: "[ffmpeg] Tentative 3: transcode video + copie audio...",
                failureLabel: "Transcode audio complet impossible"
            }
        ];

    const promise = attempts.reduce((chain, attempt, index) => chain.catch((error) => {
        if (index === 0) throw error;
        if (cancelledRef.cancelled || error.message === "Telechargement annule") throw createCancelledError();
        console.log(`[ffmpeg] ${attempt.failureLabel || "Tentative precedente en echec"}: ${error.message}`);
        removeOutputIfExists(outputPath);
        return runAttempt(attempt.mode, attempt.logMessage);
    }), runAttempt(attempts[0].mode, attempts[0].logMessage));

    return {
        promise,
        cancel: () => {
            if (!task || typeof task.cancel !== "function") return false;
            return task.cancel();
        }
    };
}

function runFfmpegConvertTask(finalUrl, inputOptions, outputPath, hooks, modeOrOptions) {
    const ffmpegMode = normalizeFfmpegMode(modeOrOptions);
    const isTranscode = ffmpegMode.mode === "transcode";
    const isVideoTranscodeCopyAudio = ffmpegMode.mode === "transcode-copy-audio";
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
            ? buildStableTranscodeOutputOptions(ffmpegMode.syncProfile)
            : isVideoTranscodeCopyAudio
                ? buildVideoTranscodeCopyAudioOutputOptions()
                : buildCopyOutputOptions();

        command
            .outputOptions(outputOptions)
            .format("mp4")
            .on("start", () => {
                console.log(`[ffmpeg] FFmpeg demarree (${ffmpegMode.mode}, sync=${ffmpegMode.syncProfile})`);
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
                safeReject(new Error(`Echec FFmpeg (${ffmpegMode.mode}): ${error.message}`));
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
    const cancelledRef = { cancelled: false };
    const cancel = () => {
        cancelled = true;
        cancelledRef.cancelled = true;
        if (currentTask && typeof currentTask.cancel === "function") currentTask.cancel();
        removeOutputIfExists(outputPath);
        return true;
    };

    const promise = findMasterM3U8(sourceUrl, httpHeaders)
        .then((masterResult) => {
            console.log(`[ffmpeg] ====== NOUVELLE CONVERSION ======`);
            console.log(`[ffmpeg] URL source: ${sourceUrl}`);
            console.log(`[ffmpeg] Master detection: ${masterResult.method} (${masterResult.isMaster ? "✅ master" : "⚠️ non-master"})`);

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
            const skipSegmentPipeline = Boolean(qualityInfo.skipSegmentPipeline);

            if (isFallback && !qualityInfo.isMaster) {
                console.log(`[ffmpeg] ⚠️  AVERTISSEMENT: URL non-master et qualité non déterminée`);
            }
            console.log(`[ffmpeg] Qualite: ${quality}`);
            console.log(`[ffmpeg] URL finale: ${finalUrl}`);
            if (qualityInfo.delivery) console.log(`[ffmpeg] Livraison HLS: ${qualityInfo.delivery}`);
            if (qualityInfo.playlistType) console.log(`[ffmpeg] Type playlist: ${qualityInfo.playlistType}`);
            if (qualityInfo.playlistAnalysis) console.log(`[ffmpeg] Analyse selection: ${JSON.stringify(qualityInfo.playlistAnalysis)}`);

            if (qualityInfo.isLiveLike) {
                // Les playlists live/event sont plus sujettes aux horodatages instables.
                const fallback = runValidatedFfmpegFallback(finalUrl, inputOptions, outputPath, hooks, cancelledRef, {
                    syncProfile: "aggressive",
                    preferAudioCopy: false,
                    logMessage: `[ffmpeg] Pipeline segments ignore: playlist ${qualityInfo.playlistType} detectee, bascule vers FFmpeg classique...`
                });
                currentTask = fallback;
                return fallback.promise.then((fallbackResult) => ({
                    outputFileName,
                    outputPath,
                    quality,
                    mode: fallbackResult?.mode || "transcode",
                    effectiveAudioStrategy: fallbackResult?.effectiveAudioStrategy || buildEffectiveAudioStrategy("transcode", "aggressive")
                }));
            }

            if (qualityInfo.playlistAnalysis?.recommendedConcatMode === "transcode") {
                // Evite la concat segments quand l'analyse detecte un VOD potentiellement instable.
                console.log("[ffmpeg] Pipeline segments ignore: VOD instable detectee, test FFmpeg direct avec transcode audio prioritaire.");
                const fallback = runValidatedFfmpegFallback(finalUrl, inputOptions, outputPath, hooks, cancelledRef, {
                    preferAudioCopy: false
                });
                currentTask = fallback;
                return fallback.promise.then((fallbackResult) => ({ outputFileName, outputPath, quality, mode: fallbackResult?.mode || "transcode", effectiveAudioStrategy: fallbackResult?.effectiveAudioStrategy || "" }));
            }

            if (skipSegmentPipeline) {
                // Les masters avec audio separee restent plus fiables en traitement direct FFmpeg.
                console.log("[ffmpeg] Pipeline segments ignore: audio HLS separee detectee.");
                const fallback = runValidatedFfmpegFallback(finalUrl, inputOptions, outputPath, hooks, cancelledRef, {
                    preferAudioCopy: false
                });
                currentTask = fallback;
                return fallback.promise.then((fallbackResult) => ({
                    outputFileName,
                    outputPath,
                    quality,
                    mode: fallbackResult?.mode || "transcode",
                    effectiveAudioStrategy: fallbackResult?.effectiveAudioStrategy || ""
                }));
            }

            console.log("[ffmpeg] Tentative 1: pipeline segments HLS...");
            currentTask = createSegmentDownloadTask(finalUrl, headers, outputPath, hooks);
            return currentTask.promise
                .then((segmentResult) => {
                    console.log(`[ffmpeg] Pipeline segments a renvoye: ${JSON.stringify(segmentResult || {})}`);
                    const mode = segmentResult?.mode || "transcode";
                    const analysis = segmentResult?.analysis || null;
                    if (analysis) console.log(`[ffmpeg] Analyse playlist: ${JSON.stringify(analysis)}`);
                    console.log(`[ffmpeg] Conversion segments terminee - qualite finale: ${quality} - mode: ${mode}`);
                    return { outputFileName, outputPath, quality, mode, effectiveAudioStrategy: buildEffectiveAudioStrategy(mode, analysis?.recommendedAudioSyncProfile) };
                })
                .catch((segmentError) => {
                    if (cancelled || segmentError.message === "Telechargement annule") throw createCancelledError();
                    console.log(`[ffmpeg] Pipeline segments indisponible: ${segmentError.message}`);
                    const fallback = runValidatedFfmpegFallback(finalUrl, inputOptions, outputPath, hooks, cancelledRef, {
                        preferAudioCopy: false
                    });
                    currentTask = fallback;
                    return fallback.promise
                        .then((fallbackResult) => {
                            const mode = fallbackResult?.mode || "transcode";
                            console.log(`[ffmpeg] FFmpeg terminee avec succes - qualite finale: ${quality} - mode: ${mode}`);
                            return { outputFileName, outputPath, quality, mode, effectiveAudioStrategy: fallbackResult?.effectiveAudioStrategy || "" };
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
