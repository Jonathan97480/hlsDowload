const { downloadYouTubeVideo, isYouTubeUrl, extractVideoId } = require("../services/youtube-download.service");
const { getSettings } = require("../services/admin-store.service");
const {
    runDownloadJob,
    getJob,
    findCompletedDownload
} = require("../services/download-job.service");
const { ensureDiskSpaceForDownload } = require("../services/storage-guard.service");

function sanitizeString(value) {
    return typeof value === "string" ? value.trim() : "";
}

function buildRequestHeaders(rawHeaders) {
    const source = rawHeaders && typeof rawHeaders === "object" ? rawHeaders : {};
    return {
        referer: sanitizeString(source.referer),
        userAgent: sanitizeString(source.userAgent),
        cookie: sanitizeString(source.cookie)
    };
}

function buildPreferredName(value, maxLength = 500) {
    return sanitizeString(value).slice(0, maxLength);
}

function getMaxTitleLengthSetting() {
    const settings = getSettings();
    const raw = Number.parseInt(settings.maxTitleLength, 10);
    if (!Number.isFinite(raw)) return 500;
    return Math.min(500, Math.max(50, raw));
}

function resolveVideoId(body) {
    const { videoId, url } = body || {};

    if (sanitizeString(videoId)) return sanitizeString(videoId);
    if (isYouTubeUrl(url)) return extractVideoId(url);
    if (sanitizeString(url)) return sanitizeString(url);

    return "";
}

async function handleYouTubeDownload(req, res) {
    try {
        const id = resolveVideoId(req.body);
        if (!id) {
            return res.status(400).json({ error: "videoId ou url YouTube requis" });
        }

        const ffmpegHeaders = buildRequestHeaders(req.body.headers);
        const maxTitleLength = getMaxTitleLengthSetting();
        const preferredName = buildPreferredName(req.body.fileName, maxTitleLength);

        const reusable = findCompletedDownload({
            url: `youtube:${id}`,
            headers: ffmpegHeaders,
            preferredName
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
                error: "Espace disque insuffisant.",
                details: {
                    minFreePercent: diskCheck.minFreePercent,
                    beforeFreePercent: diskCheck.before?.freePercent
                }
            });
        }

        const result = await downloadYouTubeVideo(id, ffmpegHeaders, {}, { preferredName });

        return res.status(201).json({
            message: "Telechargement termine",
            fileName: result.outputFileName,
            filePath: result.filePath
        });
    } catch (error) {
        return res.status(500).json({ error: error.message || "Erreur interne" });
    }
}

function startYouTubeDownload(req, res) {
    const id = resolveVideoId(req.body);
    if (!id) {
        return res.status(400).json({ error: "videoId ou url YouTube requis" });
    }

    const ffmpegHeaders = buildRequestHeaders(req.body.headers);
    const maxTitleLength = getMaxTitleLengthSetting();
    const preferredName = buildPreferredName(req.body.fileName, maxTitleLength);

    const diskCheck = ensureDiskSpaceForDownload();
    if (!diskCheck.ok) {
        return res.status(507).json({
            error: "Espace disque insuffisant.",
            details: {
                minFreePercent: diskCheck.minFreePercent,
                beforeFreePercent: diskCheck.before?.freePercent
            }
        });
    }

    const job = runDownloadJob({
        url: `youtube:${id}`,
        headers: ffmpegHeaders,
        preferredName
    });

    const statusCode = job.status === "completed" ? 200 : 202;

    return res.status(statusCode).json({
        message: job.status === "completed" ? "Fichier deja disponible" : "Job YouTube demarre",
        jobId: job.jobId,
        status: job.status,
        fileName: job.fileName,
        filePath: job.filePath
    });
}

function getYouTubeStatus(req, res) {
    const { jobId } = req.params;

    let job = getJob(jobId);

    if (!job) {
        const { getDb } = require("../services/sqlite.service");
        const db = getDb();
        const row = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId);
        if (!row) {
            return res.status(404).json({ error: "Job introuvable" });
        }
        job = {
            jobId: row.job_id,
            status: row.status,
            progress: row.progress || 0,
            timemark: row.timemark || "",
            message: row.message || "",
            fileName: row.file_name || "",
            filePath: row.file_path || "",
            ffmpegMode: row.ffmpeg_mode || "",
            error: row.error || ""
        };
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

module.exports = {
    handleYouTubeDownload,
    startYouTubeDownload,
    getYouTubeStatus
};
