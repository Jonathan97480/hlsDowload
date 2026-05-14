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
        "--no-call-home",
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

function downloadYouTubeVideo(videoIdOrUrl, headers, hooks, options) {
    if (!headers) headers = {};
    if (!hooks) hooks = {};
    if (!options) options = {};

    return new Promise(function (resolve, reject) {
        var outputFileName = createSafeOutputName(DOWNLOADS_DIR, options.preferredName || "", 200);
        var outputPath = path.join(DOWNLOADS_DIR, outputFileName);
        var args = buildYtDlpArgs(videoIdOrUrl, {
            cookie: headers.cookie,
            referer: headers.referer,
            userAgent: headers.userAgent,
            outputPath: outputPath
        });

        if (typeof hooks.onStart === "function") {
            hooks.onStart();
        }

        var child = execFile(YT_DLP_BIN, args, {
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30 * 60 * 1000,
            env: Object.assign({}, process.env)
        }, function (error, stdout, stderr) {
            if (error) {
                var message = stderr || error.message || "yt-dlp error";
                return reject(new Error(message.indexOf("ERROR:") !== -1 ? message : "yt-dlp: " + message));
            }

            if (!fs.existsSync(outputPath)) {
                return reject(new Error("Impossible de trouver le fichier telecharge"));
            }

            return resolve({
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
    downloadYouTubeVideo: downloadYouTubeVideo,
    isYouTubeUrl: isYouTubeUrl,
    extractVideoId: extractVideoId
};
