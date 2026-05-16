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

function downloadSegment(url, headers, outputPath, redirectCount = 0) {
    const transport = url.startsWith("https://") ? https : http;

    return new Promise((resolve, reject) => {
        const request = transport.get(url, { headers }, (response) => {
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;

            if (statusCode >= 300 && statusCode < 400 && location) {
                response.resume();

                if (redirectCount >= 5) {
                    reject(new Error("Trop de redirections pour le segment HLS"));
                    return;
                }

                const nextUrl = new URL(location, url).href;
                downloadSegment(nextUrl, headers, outputPath, redirectCount + 1).then(resolve).catch(reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Telechargement segment refuse (${statusCode})`));
                return;
            }

            const writer = fs.createWriteStream(outputPath);

            response.on("error", (error) => {
                writer.destroy();
                cleanupPartialFile(outputPath);
                reject(new Error(`Erreur reseau segment: ${error.message}`));
            });

            writer.on("error", (error) => {
                response.destroy();
                cleanupPartialFile(outputPath);
                reject(new Error(`Erreur ecriture segment: ${error.message}`));
            });

            writer.on("finish", () => {
                writer.close((closeError) => {
                    if (closeError) {
                        cleanupPartialFile(outputPath);
                        reject(new Error(`Erreur fermeture segment: ${closeError.message}`));
                        return;
                    }

                    resolve(outputPath);
                });
            });

            response.pipe(writer);
        });

        request.setTimeout(20000, () => {
            request.destroy(new Error("Timeout sur le telechargement du segment"));
        });
        request.on("error", (error) => {
            cleanupPartialFile(outputPath);
            reject(new Error(`Erreur telechargement segment: ${error.message}`));
        });
    });
}

async function downloadAndVerifySegment(url, headers, outputPath) {
    const requestHeaders = buildRequestHeaders(headers);
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            await downloadSegment(url, requestHeaders, outputPath);
            await verifySegmentIntegrity(outputPath);
            recordSegmentDownloaded();
            return true;
        } catch (error) {
            cleanupPartialFile(outputPath);

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
}

module.exports = {
    downloadAndVerifySegment
};
