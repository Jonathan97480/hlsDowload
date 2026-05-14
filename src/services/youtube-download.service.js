const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { ensureDownloadsDir, createSafeOutputName } = require("./file-output.service");

const YT_DLP_BIN = process.env.YT_DLP_PATH || "yt-dlp";
const DOWNLOADS_DIR = ensureDownloadsDir();
const PROGRESS_REGEX = /\[download\]\s+(\d+(?:\.\d+)?)%/;
const ETA_REGEX = /ETA\s+(\d+:\d+(?::\d+)?)/;
const SPEED_REGEX = /(\d+(?:\.\d+)?[KMG]?i?B\/s)/;

function sanitizeFilename(name, maxLength) {
    if (maxLength === undefined) maxLength = 200;
    return String(name || "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
}

function buildYtDlpArgs(videoIdOrUrl, options) {
    if (!options) options = {};
    var args = [
        "--no-warnings",
        "--no-playlist",
        "--newline",
        "--progress"
    ];

    if (options.cookie && typeof options.cookie === "string" && options.cookie.trim()) {
        args.push("--add-header", "Cookie:" + options.cookie.trim());
    }

    if (options.referer && typeof options.referer === "string" && options.referer.trim()) {
        args.push("--add-header", "Referer:" + options.referer.trim());
    }

    if (options.userAgent && typeof options.userAgent === "string" && options.userAgent.trim()) {
        args.push("--user-agent", options.userAgent.trim());
    }

    args.push(
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", options.outputPath,
        "--restrict-filenames"
    );

    var url = /^https?:\/\//i.test(videoIdOrUrl)
        ? videoIdOrUrl
        : "https://www.youtube.com/watch?v=" + videoIdOrUrl;

    args.push(url);
    return args;
}

function parseProgress(line) {
    var result = { percent: 0, speed: "", eta: "", raw: line };

    var progressMatch = line.match(PROGRESS_REGEX);
    if (progressMatch) {
        result.percent = parseFloat(progressMatch[1]) || 0;
    }

    var speedMatch = line.match(SPEED_REGEX);
    if (speedMatch) {
        result.speed = speedMatch[1];
    }

    var etaMatch = line.match(ETA_REGEX);
    if (etaMatch) {
        result.eta = etaMatch[1];
    }

    return result;
}

function removeOutputIfExists(outputPath) {
    try {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
    } catch (_error) {
        // Ignore cleanup failures on cancel.
    }
}

function removeRelatedArtifacts(outputPath) {
    removeOutputIfExists(outputPath);

    try {
        var dirPath = path.dirname(outputPath);
        var baseName = path.parse(outputPath).name;
        fs.readdirSync(dirPath).forEach(function (fileName) {
            if (!fileName.startsWith(baseName)) {
                return;
            }
            try {
                fs.unlinkSync(path.join(dirPath, fileName));
            } catch (_error) { }
        });
    } catch (_error) {
        // Ignore cleanup failures on cancel.
    }
}

function createCancelledError() {
    return new Error("Telechargement annule");
}

function createYouTubeDownloadTask(videoIdOrUrl, headers, hooks, options) {
    if (!headers) headers = {};
    if (!hooks) hooks = {};
    if (!options) options = {};

    var child = null;
    var settled = false;
    var cancelled = false;
    var outputFileName = createSafeOutputName(DOWNLOADS_DIR, options.preferredName || "", 200);
    var outputPath = path.join(DOWNLOADS_DIR, outputFileName);
    var promise = new Promise(function (resolve, reject) {
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

        var args = buildYtDlpArgs(videoIdOrUrl, {
            cookie: headers.cookie,
            referer: headers.referer,
            userAgent: headers.userAgent,
            outputPath: outputPath
        });

        if (typeof hooks.onStart === "function") {
            hooks.onStart();
        }

        child = execFile(YT_DLP_BIN, args, {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30 * 60 * 1000,
            env: Object.assign({}, process.env)
        }, function (error, stdout, stderr) {
            if (cancelled) {
                removeRelatedArtifacts(outputPath);
                return safeReject(createCancelledError());
            }

            if (error) {
                var message = stderr || error.message || "yt-dlp error";
                return safeReject(new Error(message.indexOf("ERROR:") !== -1 ? message : "yt-dlp: " + message));
            }

            if (!fs.existsSync(outputPath)) {
                return safeReject(new Error("Impossible de trouver le fichier telecharge"));
            }

            return safeResolve({
                outputFileName: outputFileName,
                outputPath: outputPath,
                filePath: "/downloads/" + outputFileName,
                mode: "yt-dlp",
                quality: "best"
            });
        });

        child.stderr.on("data", function () { });

        child.stdout.on("data", function (chunk) {
            var text = chunk.toString();
            var lines = text.split("\n").filter(Boolean);

            for (var i = 0; i < lines.length; i++) {
                var progress = parseProgress(lines[i]);

                if (progress.percent > 0 && typeof hooks.onProgress === "function") {
                    hooks.onProgress({
                        percent: progress.percent,
                        timemark: progress.eta ? "ETA " + progress.eta : "",
                        speed: progress.speed,
                        raw: lines[i]
                    });
                }
            }
        });
    });

    return {
        promise: promise,
        cancel: function () {
            if (settled || cancelled) return false;
            cancelled = true;
            if (child && typeof child.kill === "function") {
                try {
                    child.kill("SIGKILL");
                } catch (_error) { }
            }
            removeRelatedArtifacts(outputPath);
            return true;
        }
    };
}

function downloadYouTubeVideo(videoIdOrUrl, headers, hooks, options) {
    return createYouTubeDownloadTask(videoIdOrUrl, headers, hooks, options).promise;
}

function isYouTubePlaylistUrl(url) {
    if (typeof url !== "string") return false;
    try {
        var parsed = new URL(url.trim());
        if (!/^(www\.)?(youtube\.com|music\.youtube\.com)$/i.test(parsed.hostname)) {
            return false;
        }
        return !!parsed.searchParams.get("list");
    } catch (_error) {
        return false;
    }
}

function normalizeYouTubePlaylistUrl(url) {
    if (typeof url !== "string") return "";

    try {
        var parsed = new URL(url.trim());
        var listId = parsed.searchParams.get("list");
        if (!listId) return "";
        return "https://www.youtube.com/playlist?list=" + encodeURIComponent(listId.trim());
    } catch (_error) {
        return "";
    }
}

function listYouTubePlaylistVideos(playlistUrl, headers) {
    if (!headers) headers = {};

    return new Promise(function (resolve, reject) {
        var normalizedPlaylistUrl = normalizeYouTubePlaylistUrl(playlistUrl);
        if (!normalizedPlaylistUrl) {
            return reject(new Error("URL de playlist YouTube invalide"));
        }

        var args = [
            "--flat-playlist",
            "--dump-single-json",
            "--no-warnings"
        ];

        if (headers.cookie && typeof headers.cookie === "string" && headers.cookie.trim()) {
            args.push("--add-header", "Cookie:" + headers.cookie.trim());
        }

        if (headers.referer && typeof headers.referer === "string" && headers.referer.trim()) {
            args.push("--add-header", "Referer:" + headers.referer.trim());
        }

        if (headers.userAgent && typeof headers.userAgent === "string" && headers.userAgent.trim()) {
            args.push("--user-agent", headers.userAgent.trim());
        }

        args.push(normalizedPlaylistUrl);

        execFile(YT_DLP_BIN, args, {
            maxBuffer: 20 * 1024 * 1024,
            timeout: 5 * 60 * 1000,
            env: Object.assign({}, process.env)
        }, function (error, stdout, stderr) {
            if (error) {
                var message = stderr || error.message || "yt-dlp playlist error";
                if (/playlist does not exist/i.test(message)) {
                    return reject(new Error("Playlist YouTube invalide, privee ou inaccessible"));
                }
                return reject(new Error(message.indexOf("ERROR:") !== -1 ? message : "yt-dlp: " + message));
            }

            try {
                var data = JSON.parse(stdout || "{}");
                var entries = Array.isArray(data.entries) ? data.entries : [];
                var videos = entries
                    .map(function (entry, index) {
                        var id = typeof entry.id === "string" ? entry.id.trim() : "";
                        if (!id) return null;

                        return {
                            videoId: id,
                            title: typeof entry.title === "string" ? entry.title.trim() : "",
                            url: typeof entry.url === "string" && /^https?:\/\//i.test(entry.url)
                                ? entry.url.trim()
                                : "https://www.youtube.com/watch?v=" + id,
                            position: index + 1
                        };
                    })
                    .filter(Boolean);

                resolve({
                    title: typeof data.title === "string" ? data.title.trim() : "",
                    playlistId: typeof data.id === "string" ? data.id.trim() : "",
                    videos: videos
                });
            } catch (parseError) {
                reject(new Error("Impossible de lire la playlist YouTube: " + parseError.message));
            }
        });
    });
}

function isYouTubeUrl(url) {
    if (typeof url !== "string") return false;
    return /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i.test(url.trim());
}

function extractVideoId(url) {
    if (typeof url !== "string") return "";
    var trimmed = url.trim();

    var match = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];

    match = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];

    match = trimmed.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];

    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

    return "";
}

module.exports = {
    createYouTubeDownloadTask: createYouTubeDownloadTask,
    downloadYouTubeVideo: downloadYouTubeVideo,
    listYouTubePlaylistVideos: listYouTubePlaylistVideos,
    isYouTubeUrl: isYouTubeUrl,
    isYouTubePlaylistUrl: isYouTubePlaylistUrl,
    normalizeYouTubePlaylistUrl: normalizeYouTubePlaylistUrl,
    extractVideoId: extractVideoId
};
