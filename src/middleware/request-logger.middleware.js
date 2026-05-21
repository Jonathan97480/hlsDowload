function getClientIp(req) {
    const forwarded = typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0].trim()
        : "";
    const realIp = typeof req.headers["x-real-ip"] === "string" ? req.headers["x-real-ip"].trim() : "";
    const clientIp = typeof req.headers["x-client-public-ip"] === "string" ? req.headers["x-client-public-ip"].trim() : "";
    return clientIp || forwarded || realIp || req.ip || "unknown";
}

function maskApiKey(value) {
    const apiKey = typeof value === "string" ? value.trim() : "";
    if (!apiKey) {
        return "";
    }

    if (apiKey.length <= 8) {
        return `${apiKey.slice(0, 2)}***${apiKey.slice(-2)}`;
    }

    return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function summarizeCookie(value) {
    const cookie = typeof value === "string" ? value.trim() : "";
    if (!cookie) {
        return "";
    }

    const parts = cookie.split(";").map((part) => part.trim()).filter(Boolean);
    return `[${parts.length} cookie(s)] ${parts.slice(0, 3).join("; ")}`;
}

function isDownloadApiRequest(req) {
    return /^\/api\/download(\/|$)/.test(String(req.originalUrl || ""));
}

function buildExtensionPayloadLog(req, ip) {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const bodyHeaders = body.headers && typeof body.headers === "object" ? body.headers : {};
    const debug = body.debug && typeof body.debug === "object" ? body.debug : {};
    const requestSummary = {
        method: req.method,
        url: req.originalUrl || "",
        ip,
        apiKey: maskApiKey(req.headers["x-api-key"]),
        clientPublicIpHeader: req.headers["x-client-public-ip"] || "",
        clientPublicIpBody: body.clientPublicIp || "",
        fileName: body.fileName || "",
        mediaUrl: body.url || "",
        videoId: body.videoId || "",
        playlistUrl: body.playlistUrl || "",
        headers: {
            referer: bodyHeaders.referer || "",
            origin: bodyHeaders.origin || "",
            userAgent: bodyHeaders.userAgent || "",
            cookie: summarizeCookie(bodyHeaders.cookie)
        },
        debug: {
            exactEntryFound: Boolean(debug.exactEntryFound),
            networkFallbackUsed: Boolean(debug.networkFallbackUsed),
            detectedContextKeys: Array.isArray(debug.detectedContextKeys) ? debug.detectedContextKeys : [],
            mergedContextKeys: Array.isArray(debug.mergedContextKeys) ? debug.mergedContextKeys : [],
            mediaCookieCount: Number.isFinite(debug.mediaCookieCount) ? debug.mediaCookieCount : 0,
            pageCookieCount: Number.isFinite(debug.pageCookieCount) ? debug.pageCookieCount : 0,
            finalCookieCount: Number.isFinite(debug.finalCookieCount) ? debug.finalCookieCount : 0,
            originDerived: debug.originDerived || "",
            documentUrl: debug.documentUrl || "",
            requestedUrl: debug.requestedUrl || "",
            effectiveUrl: debug.effectiveUrl || "",
            selectedSource: debug.selectedSource || ""
        }
    };

    return JSON.stringify(requestSummary);
}

function attachRequestLogger(req, res, next) {
    const startedAt = Date.now();
    const ip = getClientIp(req);

    if (isDownloadApiRequest(req)) {
        console.log(`[extension-request] ${buildExtensionPayloadLog(req, ip)}`);
    }

    res.on("finish", () => {
        const durationMs = Date.now() - startedAt;
        const status = res.statusCode;
        const level = status >= 400 ? "warn" : "log";
        const payloadSize = res.getHeader("content-length") || 0;
        console[level](
            `[http] ${req.method} ${req.originalUrl} -> ${status} ${durationMs}ms ip=${ip} bytes=${payloadSize}`
        );
    });

    next();
}

module.exports = {
    attachRequestLogger
};
