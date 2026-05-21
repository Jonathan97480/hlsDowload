const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { ensureDownloadsDir, createSafeOutputName } = require("./file-output.service");

function buildRequestHeaders(headers) {
    const requestHeaders = {};

    if (headers?.referer) {
        requestHeaders.Referer = headers.referer;
    }

    if (headers?.userAgent) {
        requestHeaders["User-Agent"] = headers.userAgent;
    }

    if (headers?.cookie) {
        requestHeaders.Cookie = headers.cookie;
    }

    if (headers?.origin) {
        requestHeaders.Origin = headers.origin;
    }

    return requestHeaders;
}

function requestWithRedirect(url, headers, redirectCount = 0) {
    const transport = url.startsWith("https://") ? https : http;

    return new Promise((resolve, reject) => {
        const req = transport.get(url, { headers }, (response) => {
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;

            if (statusCode >= 300 && statusCode < 400 && location) {
                response.resume();

                if (redirectCount >= 5) {
                    reject(new Error("Trop de redirections pour le telechargement direct"));
                    return;
                }

                const nextUrl = new URL(location, url).href;
                requestWithRedirect(nextUrl, headers, redirectCount + 1).then(resolve).catch(reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Telechargement direct refuse (${statusCode})`));
                return;
            }

            resolve(response);
        });

        req.setTimeout(20000, () => {
            req.destroy(new Error("Timeout sur le telechargement direct"));
        });
        req.on("error", (error) => reject(new Error(`Erreur reseau: ${error.message}`)));
    });
}

async function downloadDirectMp4(sourceUrl, headers = {}, hooks = {}, options = {}) {
    return createDirectDownloadTask(sourceUrl, headers, hooks, options).promise;
}

function createDirectDownloadTask(sourceUrl, headers = {}, hooks = {}, options = {}) {
    const downloadsDir = ensureDownloadsDir();
    const parsedMaxTitleLength = Number.parseInt(options.maxTitleLength, 10);
    const maxTitleLength = Number.isFinite(parsedMaxTitleLength)
        ? Math.min(500, Math.max(50, parsedMaxTitleLength))
        : 500;
    const outputFileName = createSafeOutputName(downloadsDir, options.preferredName || "", maxTitleLength);
    const outputPath = path.join(downloadsDir, outputFileName);
    const requestHeaders = buildRequestHeaders(headers);
    let fileWriter = null;
    let response = null;
    let cancelled = false;
    let settled = false;

    const promise = requestWithRedirect(sourceUrl, requestHeaders).then((res) => {
        response = res;

        if (typeof hooks.onStart === "function") {
            hooks.onStart();
        }

        const totalBytes = Number.parseInt(response.headers["content-length"], 10);

        return new Promise((resolve, reject) => {
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

            let downloadedBytes = 0;
            let lastPercent = -1;
            fileWriter = fs.createWriteStream(outputPath);

            response.on("data", (chunk) => {
                downloadedBytes += chunk.length;

                if (!Number.isFinite(totalBytes) || totalBytes <= 0 || typeof hooks.onProgress !== "function") {
                    return;
                }

                const percent = Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
                if (percent !== lastPercent) {
                    lastPercent = percent;
                    hooks.onProgress({ percent, timemark: "" });
                }
            });

            response.on("error", (error) => {
                if (cancelled) {
                    cleanupPartial(outputPath, fileWriter, safeReject, new Error("Telechargement annule"));
                    return;
                }
                cleanupPartial(outputPath, fileWriter, safeReject, error);
            });

            fileWriter.on("error", (error) => {
                cleanupPartial(outputPath, fileWriter, safeReject, error);
            });

            fileWriter.on("finish", () => {
                fileWriter.close((closeError) => {
                    if (closeError) {
                        cleanupPartial(outputPath, fileWriter, safeReject, closeError);
                        return;
                    }

                    if (cancelled) {
                        cleanupPartial(outputPath, fileWriter, safeReject, new Error("Telechargement annule"));
                        return;
                    }

                    safeResolve({
                        outputFileName,
                        outputPath,
                        quality: "direct",
                        mode: "direct"
                    });
                });
            });

            response.pipe(fileWriter);
        });
    });

    return {
        promise,
        cancel: () => {
            if (cancelled || settled) return false;
            cancelled = true;
            try {
                if (response && typeof response.destroy === "function") response.destroy(new Error("Telechargement annule"));
            } catch (_error) { }
            try {
                if (fileWriter && typeof fileWriter.destroy === "function") fileWriter.destroy(new Error("Telechargement annule"));
            } catch (_error) { }
            try {
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch (_error) { }
            return true;
        }
    };
}

function cleanupPartial(outputPath, fileWriter, reject, error) {
    fileWriter.destroy();
    try {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
    } catch (_cleanupError) {
        // Ignore cleanup failures after the main error.
    }

    reject(new Error(`Echec telechargement direct: ${error.message}`));
}

module.exports = {
    createDirectDownloadTask,
    downloadDirectMp4
};
