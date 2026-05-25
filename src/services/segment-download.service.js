const fs = require("fs");
const http = require("http");
const https = require("https");
const { verifySegmentIntegrity } = require("./video-validation.service");
const {
    recordSegmentCorrupted,
    recordSegmentDownloaded,
    recordSegmentRetry
} = require("./hls-segment-stats.service");

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

    return requestHeaders;
}

function cleanupPartialFile(outputPath) {
    try {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
    } catch (_error) {
        // Ignore cleanup failures after a network or validation error.
    }
}

function createCancelledError() {
    return new Error("Telechargement annule");
}

function createSegmentRequestTask(url, headers, outputPath, redirectCount = 0) {
    const transport = url.startsWith("https://") ? https : http;
    let request = null;
    let response = null;
    let writer = null;
    let cancelled = false;
    let settled = false;

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

        request = transport.get(url, { headers }, (incomingResponse) => {
            response = incomingResponse;
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;

            if (statusCode >= 300 && statusCode < 400 && location) {
                response.resume();

                if (redirectCount >= 5) {
                    safeReject(new Error("Trop de redirections pour le segment HLS"));
                    return;
                }

                const nextUrl = new URL(location, url).href;
                const redirectedTask = createSegmentRequestTask(nextUrl, headers, outputPath, redirectCount + 1);
                request = { destroy: redirectedTask.cancel };
                redirectedTask.promise.then(safeResolve).catch(safeReject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                safeReject(new Error(`Telechargement segment refuse (${statusCode})`));
                return;
            }

            writer = fs.createWriteStream(outputPath);

            response.on("error", (error) => {
                writer.destroy();
                cleanupPartialFile(outputPath);
                safeReject(new Error(`Erreur reseau segment: ${error.message}`));
            });

            writer.on("error", (error) => {
                response.destroy();
                cleanupPartialFile(outputPath);
                safeReject(new Error(`Erreur ecriture segment: ${error.message}`));
            });

            writer.on("finish", () => {
                writer.close((closeError) => {
                    if (cancelled) {
                        cleanupPartialFile(outputPath);
                        safeReject(createCancelledError());
                        return;
                    }

                    if (closeError) {
                        cleanupPartialFile(outputPath);
                        safeReject(new Error(`Erreur fermeture segment: ${closeError.message}`));
                        return;
                    }

                    safeResolve(outputPath);
                });
            });

            response.pipe(writer);
        });

        request.setTimeout(20000, () => {
            request.destroy(new Error("Timeout sur le telechargement du segment"));
        });
        request.on("error", (error) => {
            cleanupPartialFile(outputPath);
            safeReject(cancelled ? createCancelledError() : new Error(`Erreur telechargement segment: ${error.message}`));
        });
    });

    return {
        promise,
        cancel: () => {
            if (settled || cancelled) return false;
            cancelled = true;
            try { if (response) response.destroy(createCancelledError()); } catch (_error) { }
            try { if (writer) writer.destroy(createCancelledError()); } catch (_error) { }
            try { if (request && typeof request.destroy === "function") request.destroy(createCancelledError()); } catch (_error) { }
            cleanupPartialFile(outputPath);
            return true;
        }
    };
}

async function downloadAndVerifySegment(url, headers, outputPath) {
    return createSegmentDownloadTask(url, headers, outputPath).promise;
}

function createSegmentDownloadTask(url, headers, outputPath) {
    const requestHeaders = buildRequestHeaders(headers);
    const maxRetries = 3;
    let activeTask = null;
    let cancelled = false;

    const promise = (async () => {
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
            try {
                if (cancelled) {
                    throw createCancelledError();
                }

                activeTask = createSegmentRequestTask(url, requestHeaders, outputPath);
                await activeTask.promise;
                if (cancelled) {
                    throw createCancelledError();
                }
                await verifySegmentIntegrity(outputPath);
                recordSegmentDownloaded();
                return true;
            } catch (error) {
                cleanupPartialFile(outputPath);

                if (cancelled || error.message === "Telechargement annule") {
                    throw createCancelledError();
                }

                if (attempt < maxRetries) {
                    recordSegmentRetry();
                    console.error(`Retry ${attempt}/${maxRetries - 1} for segment ${url}: ${error.message}`);
                    continue;
                }

                recordSegmentCorrupted();
                throw new Error(`Echec segment HLS apres ${maxRetries} tentatives: ${error.message}`);
            }
        }
        return false;
    })();

    return {
        promise,
        cancel: () => {
            cancelled = true;
            if (activeTask && typeof activeTask.cancel === "function") {
                activeTask.cancel();
            }
            cleanupPartialFile(outputPath);
            return true;
        }
    };
}

module.exports = {
    createSegmentDownloadTask,
    downloadAndVerifySegment
};
