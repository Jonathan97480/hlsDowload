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
const { buildDownloadContext, sanitizeString } = require("../services/request-context.service");

function buildRequestHeaders(rawHeaders) {
    const source = rawHeaders && typeof rawHeaders === "object" ? rawHeaders : {};
    const referer = sanitizeString(source.referer);
    const userAgent = sanitizeString(source.userAgent);
    const cookie = sanitizeString(source.cookie);
    const origin = sanitizeString(source.origin);

    return {
        referer,
        userAgent,
        cookie,
        origin
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
        sourceIp: job.sourceIp || "",
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
