const { createHlsDownloadTask, downloadHlsToMp4 } = require("./ffmpeg.service");
const { createDirectDownloadTask, downloadDirectMp4 } = require("./direct-download.service");

function normalizeUrl(url) {
    return typeof url === "string" ? url.trim() : "";
}

function getDownloadSourceType(url) {
    const normalized = normalizeUrl(url);

    if (!/^https?:\/\//i.test(normalized)) {
        return "";
    }

    if (/\.m3u8(\?.*)?$/i.test(normalized)) {
        return "hls";
    }

    if (/\.mp4(\?.*)?$/i.test(normalized)) {
        return "direct";
    }

    return "";
}

function isSupportedDownloadUrl(url) {
    return !!getDownloadSourceType(url);
}

function getExpectedUrlHint() {
    return "URL invalide: attendu http(s)://...m3u8 ou http(s)://...mp4";
}

function downloadMediaToMp4(url, headers = {}, hooks = {}, options = {}) {
    return createDownloadTask(url, headers, hooks, options).promise;
}

function createDownloadTask(url, headers = {}, hooks = {}, options = {}) {
    const sourceType = getDownloadSourceType(url);

    if (sourceType === "hls") {
        return createHlsDownloadTask(url, headers, hooks, options);
    }

    if (sourceType === "direct") {
        return createDirectDownloadTask(url, headers, hooks, options);
    }

    return {
        promise: Promise.reject(new Error(getExpectedUrlHint())),
        cancel: () => false
    };
}

async function downloadAndVerifySegment(url, headers, outputPath) {
    let attempts = 0;
    const maxRetries = 3;

    while (attempts < maxRetries) {
        try {
            await downloadSegment(url, headers, outputPath); // Assume downloadSegment exists
            await verifySegmentIntegrity(outputPath); // Call the new verification function
            return true; // Success
        } catch (error) {
            attempts++;
            console.error(`Retry ${attempts}/${maxRetries} for segment ${url}: ${error.message}`);
            if (attempts >= maxRetries) {
                throw new Error(`Failed to download and verify segment after ${maxRetries} attempts.`);
            }
        }
    }
}

module.exports = {
    createDownloadTask,
    downloadMediaToMp4,
    getDownloadSourceType,
    getExpectedUrlHint,
    isSupportedDownloadUrl,
    downloadAndVerifySegment
};
