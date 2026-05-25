const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createSegmentDownloadTask: createSingleSegmentDownloadTask } = require("./segment-download.service");
const { buildCopyOutputOptions, buildStableTranscodeOutputOptions } = require("./ffmpeg-output-options.service");
const { analyzePlaylist } = require("./hls-playlist-analysis.service");
const { fetchHlsText } = require("./hls-http.service");
const { validateOutputFile } = require("./video-validation.service");

function buildHttpHeaders(headers) {
    const requestHeaders = { "User-Agent": "Mozilla/5.0" };

    if (headers?.referer) {
        requestHeaders.Referer = headers.referer;
    }

    if (headers?.userAgent) {
        requestHeaders["User-Agent"] = headers.userAgent;
    }

    if (headers?.cookie) {
        requestHeaders.Cookie = headers.cookie;
    }

    return requestHeaders;
}

function parseMediaPlaylist(playlistUrl, content) {
    const lines = String(content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    if (!lines.some((line) => line.startsWith("#EXTM3U"))) {
        throw new Error("Playlist HLS invalide");
    }

    if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
        throw new Error("Playlist master non supportee en mode segments");
    }

    if (lines.some((line) => line.startsWith("#EXT-X-KEY"))) {
        throw new Error("Playlist chiffree non supportee en mode segments");
    }

    if (lines.some((line) => line.startsWith("#EXT-X-MAP"))) {
        throw new Error("Playlist fMP4 non supportee en mode segments");
    }

    const segmentUrls = lines
        .filter((line) => !line.startsWith("#"))
        .map((line) => new URL(line, playlistUrl).href);

    if (segmentUrls.length === 0) {
        throw new Error("Aucun segment detecte dans la playlist");
    }

    return {
        segmentUrls,
        analysis: analyzePlaylist(lines)
    };
}

function createTempDir() {
    const dirPath = path.join(os.tmpdir(), `hls-segments-${crypto.randomUUID()}`);
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function cleanupTempDir(dirPath) {
    if (!dirPath) {
        return;
    }

    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
    } catch (_error) {
        // Ignore temp cleanup failures.
    }
}

function removeOutputIfExists(outputPath) {
    try {
        if (outputPath && fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
    } catch (_error) {
        // Ignore output cleanup failures after cancel/error.
    }
}

function escapeConcatPath(filePath) {
    return filePath.replace(/'/g, "'\\''");
}

function writeConcatFile(segmentPaths, tempDir) {
    const concatFilePath = path.join(tempDir, "segments.txt");
    const content = segmentPaths.map((segmentPath) => `file '${escapeConcatPath(segmentPath)}'`).join("\n");
    fs.writeFileSync(concatFilePath, content, "utf8");
    return concatFilePath;
}

function runConcatTask(concatFilePath, outputPath, mode, syncProfile = "soft") {
    const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
    const args = [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFilePath
    ];

    if (mode === "transcode") {
        args.push(...buildStableTranscodeOutputOptions(syncProfile));
    } else {
        args.push(...buildCopyOutputOptions());
    }
    args.push(outputPath);

    let child = null;
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

        child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            safeReject(new Error(`Concat segments impossible: ${error.message}`));
        });

        child.on("close", (code) => {
            if (cancelled) {
                safeReject(new Error("Telechargement annule"));
                return;
            }

            if (code === 0) {
                safeResolve();
                return;
            }

            safeReject(new Error(`Concat segments en echec (${mode}): ${stderr.trim() || `exit ${code}`}`));
        });
    });

    return {
        promise,
        cancel: () => {
            if (settled || cancelled) return false;
            cancelled = true;
            try {
                if (child) {
                    child.kill("SIGKILL");
                }
            } catch (_error) {
                // Ignore process kill failures during cancellation.
            }
            return true;
        }
    };
}

function createConcurrentSegmentDownloadTask(segmentUrls, tempDir, headers, hooks, shouldCancel) {
    const maxParallel = Math.min(
        8,
        Math.max(2, Number.parseInt(process.env.HLS_SEGMENT_CONCURRENCY || "4", 10) || 4)
    );
    const segmentPaths = new Array(segmentUrls.length);
    const activeTasks = new Set();
    let nextIndex = 0;
    let completedCount = 0;

    async function worker() {
        while (nextIndex < segmentUrls.length) {
            if (shouldCancel()) {
                throw new Error("Telechargement annule");
            }

            const index = nextIndex;
            nextIndex += 1;

            const segmentUrl = segmentUrls[index];
            const segmentPath = path.join(tempDir, `segment-${String(index).padStart(5, "0")}.ts`);
            const segmentTask = createSingleSegmentDownloadTask(segmentUrl, headers, segmentPath);
            activeTasks.add(segmentTask);
            try {
                await segmentTask.promise;
            } finally {
                activeTasks.delete(segmentTask);
            }
            segmentPaths[index] = segmentPath;
            completedCount += 1;

            if (typeof hooks.onProgress === "function") {
                const percent = Math.max(1, Math.min(90, Math.round((completedCount / segmentUrls.length) * 90)));
                hooks.onProgress({ percent, timemark: "" });
            }
        }
    }

    const promise = Promise.all(
        Array.from({ length: Math.min(maxParallel, segmentUrls.length) }, () => worker())
    ).then(() => segmentPaths);

    return {
        promise,
        cancel: () => {
            for (const task of activeTasks) {
                if (typeof task.cancel === "function") {
                    task.cancel();
                }
            }
            return true;
        }
    };
}

function createSegmentDownloadTask(playlistUrl, headers, outputPath, hooks = {}) {
    const httpHeaders = buildHttpHeaders(headers);
    const tempDir = createTempDir();
    let cancelled = false;
    let concatTask = null;
    let downloadPhaseActive = false;
    let activeDownloadTask = null;

    const cancel = () => {
        cancelled = true;
        if (activeDownloadTask && typeof activeDownloadTask.cancel === "function") {
            activeDownloadTask.cancel();
        }
        if (concatTask && typeof concatTask.cancel === "function") {
            concatTask.cancel();
        }
        removeOutputIfExists(outputPath);
        if (!downloadPhaseActive) {
            cleanupTempDir(tempDir);
        }
        return true;
    };

    const promise = fetchHlsText(playlistUrl, httpHeaders)
        .then((content) => parseMediaPlaylist(playlistUrl, content))
        .then(async ({ segmentUrls, analysis }) => {
            if (analysis?.isLiveLike) {
                throw new Error(`Playlist ${analysis.playlistType || "live"} non supportee en mode segments`);
            }

            if (typeof hooks.onStart === "function") {
                hooks.onStart();
            }

            downloadPhaseActive = true;
            activeDownloadTask = createConcurrentSegmentDownloadTask(
                segmentUrls,
                tempDir,
                headers,
                hooks,
                () => cancelled
            );
            const segmentPaths = await activeDownloadTask.promise;
            activeDownloadTask = null;
            downloadPhaseActive = false;

            return { segmentPaths, analysis };
        })
        .then(async ({ segmentPaths, analysis }) => {
            const concatFilePath = writeConcatFile(segmentPaths, tempDir);
            const concatMode = analysis.recommendedConcatMode || "transcode";
            const syncProfile = analysis.recommendedAudioSyncProfile || "soft";

            concatTask = runConcatTask(concatFilePath, outputPath, concatMode, syncProfile);
            await concatTask.promise;
            return { mode: concatMode, analysis };
        })
        .then(async ({ mode, analysis }) => {
            if (cancelled) {
                throw new Error("Telechargement annule");
            }

            await validateOutputFile(outputPath);

            if (typeof hooks.onProgress === "function") {
                hooks.onProgress({ percent: 100, timemark: "" });
            }

            cleanupTempDir(tempDir);
            return { mode, analysis };
        })
        .catch((error) => {
            removeOutputIfExists(outputPath);
            cleanupTempDir(tempDir);
            throw error;
        });

    return {
        promise,
        cancel
    };
}

module.exports = {
    createSegmentDownloadTask
};
