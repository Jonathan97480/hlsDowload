function sanitizeString(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim();
}

function normalizeIpCandidate(value) {
    const raw = sanitizeString(value);

    if (!raw) {
        return "";
    }

    const first = raw.includes(",") ? raw.split(",")[0].trim() : raw;
    return first.replace(/^::ffff:/i, "");
}

function isPrivateIpv4(ipAddress) {
    return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(ipAddress);
}

function isPrivateIpv6(ipAddress) {
    const lower = ipAddress.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

function isPublicIp(ipAddress) {
    const value = normalizeIpCandidate(ipAddress);

    if (!value) {
        return false;
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        return !isPrivateIpv4(value);
    }

    if (/^[0-9a-f:]+$/i.test(value)) {
        return !isPrivateIpv6(value);
    }

    return false;
}

function resolveClientIp(req) {
    const headers = req.headers || {};
    const body = req.body && typeof req.body === "object" ? req.body : {};

    const candidates = [
        headers["x-client-public-ip"],
        body.clientPublicIp,
        headers["x-forwarded-for"],
        headers["x-real-ip"],
        req.ip
    ];

    for (const candidate of candidates) {
        if (isPublicIp(candidate)) {
            return normalizeIpCandidate(candidate);
        }
    }

    for (const candidate of candidates) {
        const normalized = normalizeIpCandidate(candidate);
        if (normalized) {
            return normalized;
        }
    }

    return "unknown";
}

function buildDownloadContext(req) {
    const headers = req.headers || {};

    return {
        clientId: sanitizeString(headers["x-extension-id"] || headers["x-client-id"] || headers["x-user-id"]),
        userAgent: sanitizeString(headers["user-agent"]),
        ipAddress: resolveClientIp(req)
    };
}

module.exports = {
    buildDownloadContext,
    sanitizeString
};
