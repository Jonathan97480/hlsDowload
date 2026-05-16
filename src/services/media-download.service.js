const { createHlsDownloadTask, downloadHlsToMp4 } = require("./ffmpeg.service");
const { createDirectDownloadTask, downloadDirectMp4 } = require("./direct-download.service");
const { downloadAndVerifySegment } = require("./segment-download.service");

function normalizeUrl(url) {
    return typeof url === "string" ? url.trim() : "";
}

function getHeuristicSourceType(normalizedUrl) {
    try {
        const parsed = new URL(normalizedUrl);
        const pathname = parsed.pathname.toLowerCase();
        const search = `${parsed.search}${parsed.hash}`.toLowerCase();
        const combined = `${pathname}${search}`;

        const blockedAssetExt = /\.(?:html?|css|js|json|txt|xml|jpg|jpeg|png|gif|svg|webp|ico|woff2?|ttf|map)$/i;
        if (blockedAssetExt.test(pathname)) {
            return "";
        }

        if (/(^|[/?=_-])(master|manifest|playlist|stream)([/?&=_-]|$)/.test(combined)) {
            return "hls";
        }

        if (/(^|[?&=_-])(format|type|output|mime)=([^#]*m3u8|[^#]*mpegurl)/.test(search)) {
            return "hls";
        }

        if (/(^|[?&=_-])(format|type|output|mime)=([^#]*mp4)/.test(search)) {
            return "direct";
        }

        if (/(^|[?&=_-])(hls|m3u8)([=&/_-]|$)/.test(search)) {
            return "hls";
        }

        if (/(^|[?&=_-])mp4([=&/_-]|$)/.test(search)) {
            return "direct";
        }
    } catch (_error) {
        return "";
    }

    return "";
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

    return getHeuristicSourceType(normalized);
}

function isSupportedDownloadUrl(url) {
    return !!getDownloadSourceType(url);
}

function getExpectedUrlHint() {
    return "URL invalide: attendu une URL http(s) de flux HLS/MP4 detectee";
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

module.exports = {
    createDownloadTask,
    downloadMediaToMp4,
    getDownloadSourceType,
    getExpectedUrlHint,
    isSupportedDownloadUrl,
    downloadAndVerifySegment
};
