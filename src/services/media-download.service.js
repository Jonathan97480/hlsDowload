const { downloadHlsToMp4 } = require("./ffmpeg.service");
const { downloadDirectMp4 } = require("./direct-download.service");

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
    const sourceType = getDownloadSourceType(url);

    if (sourceType === "hls") {
        return downloadHlsToMp4(url, headers, hooks, options);
    }

    if (sourceType === "direct") {
        return downloadDirectMp4(url, headers, hooks, options);
    }

    return Promise.reject(new Error(getExpectedUrlHint()));
}

module.exports = {
    downloadMediaToMp4,
    getDownloadSourceType,
    getExpectedUrlHint,
    isSupportedDownloadUrl
};
