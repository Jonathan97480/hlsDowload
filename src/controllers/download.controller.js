const { getSettings } = require("../services/admin-store.service");
const {
    downloadMediaToMp4,
    getExpectedUrlHint,
    isSupportedDownloadUrl
} = require("../services/media-download.service");
const {
    runDownloadJob,
    cancelJob,
    clearQueuedJobs,
    getJob,
    findCompletedDownload,
    getCapacitySnapshot
} = require("../services/download-job.service");
const { ensureDiskSpaceForDownload } = require("../services/storage-guard.service");

function sanitizeString(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value.trim();
}

function buildRequestHeaders(rawHeaders) {
    const source = rawHeaders && typeof rawHeaders === "object" ? rawHeaders : {};
    const referer = sanitizeString(source.referer);
    const userAgent = sanitizeString(source.userAgent);
    const cookie = sanitizeString(source.cookie);

    return {
        referer,
        userAgent,
        cookie
    };
}

function buildPreferredName(value, maxLength = 500) {
    return sanitizeString(value).slice(0, maxLength);
}

function getMaxTitleLengthSetting() {
    const settings = getSettings();
    const raw = Number.parseInt(settings.maxTitleLength, 10);

    if (!Number.isFinite(raw)) {
        return 500;
    }

    return Math.min(500, Math.max(50, raw));
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

async function handleDownload(req, res) {
    try {
        const { url, headers, fileName } = req.body || {};

        if (!isSupportedDownloadUrl(url)) {
            return res.status(400).json({
                error: getExpectedUrlHint()
            });
        }

        const ffmpegHeaders = buildRequestHeaders(headers);
        const maxTitleLength = getMaxTitleLengthSetting();
        const preferredName = buildPreferredName(fileName, maxTitleLength);
        const downloadContext = buildDownloadContext(req);
        const reusable = findCompletedDownload({
            url: url.trim(),
            headers: ffmpegHeaders,
            preferredName,
            ...downloadContext
        });

        if (reusable) {
            return res.status(200).json({
                message: "Fichier deja disponible",
                fileName: reusable.fileName,
                filePath: reusable.filePath,
                reused: true
            });
        }

        const diskCheck = ensureDiskSpaceForDownload();
        if (!diskCheck.ok) {
            return res.status(507).json({
                error: "Espace disque insuffisant. Relancez plus tard.",
                details: {
                    minFreePercent: diskCheck.minFreePercent,
                    beforeFreePercent: diskCheck.before?.freePercent,
                    afterFreePercent: diskCheck.after?.freePercent,
                    deletedFiles: diskCheck.deletedFiles?.map((file) => file.fileName) || []
                }
            });
        }

        const result = await downloadMediaToMp4(url.trim(), ffmpegHeaders, {}, {
            preferredName,
            maxTitleLength,
            ...downloadContext
        });

        return res.status(201).json({
            message: "Telechargement termine",
            fileName: result.outputFileName,
            filePath: `/downloads/${result.outputFileName}`
        });
    } catch (error) {
        return res.status(500).json({
            error: error.message || "Erreur interne"
        });
    }
}

function startDownload(req, res) {
    const { url, headers, fileName } = req.body || {};

    if (!isSupportedDownloadUrl(url)) {
        return res.status(400).json({
            error: getExpectedUrlHint()
        });
    }

    const ffmpegHeaders = buildRequestHeaders(headers);
    const maxTitleLength = getMaxTitleLengthSetting();
    const preferredName = buildPreferredName(fileName, maxTitleLength);
    const downloadContext = buildDownloadContext(req);

    const diskCheck = ensureDiskSpaceForDownload();
    if (!diskCheck.ok) {
        return res.status(507).json({
            error: "Espace disque insuffisant. Impossible de demarrer le job.",
            details: {
                minFreePercent: diskCheck.minFreePercent,
                beforeFreePercent: diskCheck.before?.freePercent,
                afterFreePercent: diskCheck.after?.freePercent,
                deletedFiles: diskCheck.deletedFiles?.map((file) => file.fileName) || []
            }
        });
    }

    const job = runDownloadJob({
        url: url.trim(),
        headers: ffmpegHeaders,
        preferredName,
        maxTitleLength,
        ...downloadContext
    });

    const statusCode = job.status === "completed" ? 200 : 202;

    return res.status(statusCode).json({
        message: job.status === "completed" ? "Fichier deja disponible" : "Job demarre",
        jobId: job.jobId,
        status: job.status,
        fileName: job.fileName,
        filePath: job.filePath
    });
}

function getDownloadStatus(req, res) {
    const { jobId } = req.params;
    const job = getJob(jobId);

    if (!job) {
        return res.status(404).json({
            error: "Job introuvable"
        });
    }

    return res.status(200).json({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        timemark: job.timemark,
        message: job.message,
        fileName: job.fileName,
        filePath: job.filePath,
        ffmpegMode: job.ffmpegMode || "",
        error: job.error
    });
}

function getDownloadCapacity(_req, res) {
    return res.status(200).json(getCapacitySnapshot());
}

function stopDownloadJob(req, res) {
    const { jobId } = req.params;
    const result = cancelJob(jobId);

    if (!result.ok) {
        return res.status(404).json({ error: result.error || "Job introuvable" });
    }

    return res.status(200).json({
        message: "Arret demande",
        status: result.status
    });
}

function clearDownloadQueue(_req, res) {
    const result = clearQueuedJobs();

    return res.status(200).json({
        message: "File d'attente videe",
        clearedCount: result.clearedCount
    });
}

module.exports = {
    handleDownload,
    startDownload,
    getDownloadStatus,
    getDownloadCapacity,
    stopDownloadJob,
    clearDownloadQueue
};
