const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { downloadAndVerifySegment } = require("./segment-download.service");
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

function fetchText(url, headers, redirectCount = 0) {
    const transport = url.startsWith("https://") ? https : http;

    return new Promise((resolve, reject) => {
        const req = transport.get(url, { headers }, (response) => {
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;

            if (statusCode >= 300 && statusCode < 400 && location) {
                response.resume();

                if (redirectCount >= 5) {
                    reject(new Error("Trop de redirections pour la playlist HLS"));
                    return;
                }

                const nextUrl = new URL(location, url).href;
                fetchText(nextUrl, headers, redirectCount + 1).then(resolve).catch(reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Lecture playlist refusee (${statusCode})`));
                return;
            }

            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                data += chunk;
            });
            response.on("end", () => resolve(data));
            response.on("error", (error) => reject(new Error(`Erreur lecture playlist: ${error.message}`)));
        });

        req.setTimeout(20000, () => {
            req.destroy(new Error("Timeout sur la playlist HLS"));
        });
        req.on("error", (error) => reject(new Error(`Erreur requete playlist: ${error.message}`)));
    });
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

    return segmentUrls;
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

function runConcatTask(concatFilePath, outputPath, mode) {
    const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
    const args = [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concatFilePath
    ];

    if (mode === "transcode") {
        args.push(
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "22",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k"
        );
    } else {
        args.push(
            "-c", "copy",
            "-bsf:a", "aac_adtstoasc"
        );
    }

    args.push("-movflags", "+faststart", outputPath);

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

function createSegmentDownloadTask(playlistUrl, headers, outputPath, hooks = {}) {
    const httpHeaders = buildHttpHeaders(headers);
    const tempDir = createTempDir();
    let cancelled = false;
    let concatTask = null;

    const cancel = () => {
        cancelled = true;
        if (concatTask && typeof concatTask.cancel === "function") {
            concatTask.cancel();
        }
        removeOutputIfExists(outputPath);
        cleanupTempDir(tempDir);
        return true;
    };

    const promise = fetchText(playlistUrl, httpHeaders)
        .then((content) => parseMediaPlaylist(playlistUrl, content))
        .then(async (segmentUrls) => {
            if (typeof hooks.onStart === "function") {
                hooks.onStart();
            }

            const segmentPaths = [];

            for (const [index, segmentUrl] of segmentUrls.entries()) {
                if (cancelled) {
                    throw new Error("Telechargement annule");
                }

                const segmentPath = path.join(tempDir, `segment-${String(index).padStart(5, "0")}.ts`);
                await downloadAndVerifySegment(segmentUrl, headers, segmentPath);
                segmentPaths.push(segmentPath);

                if (typeof hooks.onProgress === "function") {
                    const percent = Math.max(1, Math.min(90, Math.round(((index + 1) / segmentUrls.length) * 90)));
                    hooks.onProgress({ percent, timemark: "" });
                }
            }

            return segmentPaths;
        })
        .then(async (segmentPaths) => {
            const concatFilePath = writeConcatFile(segmentPaths, tempDir);

            concatTask = runConcatTask(concatFilePath, outputPath, "copy");
            try {
                await concatTask.promise;
            } catch (error) {
                if (cancelled || error.message === "Telechargement annule") {
                    throw error;
                }

                concatTask = runConcatTask(concatFilePath, outputPath, "transcode");
                await concatTask.promise;
                return "transcode";
            }

            return "copy";
        })
        .then(async (mode) => {
            if (cancelled) {
                throw new Error("Telechargement annule");
            }

            await validateOutputFile(outputPath);

            if (typeof hooks.onProgress === "function") {
                hooks.onProgress({ percent: 100, timemark: "" });
            }

            cleanupTempDir(tempDir);
            return { mode };
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
