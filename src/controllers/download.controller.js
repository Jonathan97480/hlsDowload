const { downloadHlsToMp4 } = require("../services/ffmpeg.service");
const {
    runDownloadJob,
    getJob,
    findCompletedDownload,
    getCapacitySnapshot
} = require("../services/download-job.service");
const { ensureDiskSpaceForDownload } = require("../services/storage-guard.service");

function isValidHlsUrl(url) {
    if (typeof url !== "string") {
        return false;
    }

    const trimmed = url.trim();

    return /^https?:\/\//i.test(trimmed) && /\.m3u8(\?.*)?$/i.test(trimmed);
}

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

function buildPreferredName(value) {
    return sanitizeString(value).slice(0, 160);
}

function anonymizeIp(ipAddress) {
    const value = sanitizeString(ipAddress);

    if (!value) {
        return "unknown";
    }

    if (value.includes(".")) {
        const parts = value.split(".");
        if (parts.length >= 4) {
            return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
        }
    }

    if (value.includes(":")) {
        const parts = value.split(":");
        return `${parts.slice(0, 4).join(":")}:xxxx`;
    }

    return value.length > 3 ? `${value.slice(0, 3)}***` : "unknown";
}

function buildDownloadContext(req) {
    const headers = req.headers || {};

    return {
        clientId: sanitizeString(headers["x-extension-id"] || headers["x-client-id"] || headers["x-user-id"]),
        userAgent: sanitizeString(headers["user-agent"]),
        ipAddress: anonymizeIp(req.ip || headers["x-forwarded-for"] || headers["x-real-ip"])
    };
}

async function handleDownload(req, res) {
    try {
        const { url, headers, fileName } = req.body || {};

        if (!isValidHlsUrl(url)) {
            return res.status(400).json({
                error: "URL invalide: attendu http(s)://...m3u8"
            });
        }

        const ffmpegHeaders = buildRequestHeaders(headers);
        const preferredName = buildPreferredName(fileName);
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

        const result = await downloadHlsToMp4(url.trim(), ffmpegHeaders, {}, { preferredName, ...downloadContext });

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

    if (!isValidHlsUrl(url)) {
        return res.status(400).json({
            error: "URL invalide: attendu http(s)://...m3u8"
        });
    }

    const ffmpegHeaders = buildRequestHeaders(headers);
    const preferredName = buildPreferredName(fileName);
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
        error: job.error
    });
}

function getDownloadCapacity(_req, res) {
    return res.status(200).json(getCapacitySnapshot());
}

module.exports = {
    handleDownload,
    startDownload,
    getDownloadStatus,
    getDownloadCapacity
};
