const { downloadYouTubeVideo, isYouTubeUrl, extractVideoId } = require("../services/youtube-download.service");
const { getSettings } = require("../services/admin-store.service");
const {
    runDownloadJob,
    getJob,
    findCompletedDownload,
    getCapacitySnapshot
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

    const { v4: uuidv4 } = require("uuid");
    const { getDb } = require("../services/sqlite.service");
    const db = getDb();

    const jobId = uuidv4();
    const now = Date.now();
    const requestKey = JSON.stringify({ url: `youtube:${id}`, preferredName, headers: ffmpegHeaders });

    const job = {
        jobId,
        url: `youtube:${id}`,
        preferredName,
        headers: ffmpegHeaders,
        status: "queued",
        progress: 0,
        timemark: "",
        message: "En attente (YouTube)",
        fileName: "",
        filePath: "",
        ffmpegMode: "",
        fileSizeBytes: 0,
        sourceIp: "",
        clientId: "",
        userAgent: "",
        startedAt: 0,
        completedAt: 0,
        durationMs: 0,
        error: "",
        updatedAt: now,
        createdAt: now
    };

    const upsertStmt = db.prepare(`
        INSERT INTO jobs (
            job_id, request_key, url, preferred_name, headers_json, status, progress,
            timemark, message, file_name, file_path, ffmpeg_mode, file_size_bytes, source_ip,
            client_id, user_agent, started_at, completed_at, duration_ms, error,
            updated_at, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    `);
    upsertStmt.run(
        job.jobId, requestKey, job.url, job.preferredName, JSON.stringify(job.headers),
        job.status, job.progress, job.timemark, job.message, job.fileName, job.filePath,
        job.ffmpegMode, job.fileSizeBytes, job.sourceIp, job.clientId, job.userAgent,
        job.startedAt, job.completedAt, job.durationMs, job.error, job.updatedAt, job.createdAt
    );

    runYouTubeJob(job);

    return res.status(202).json({
        message: "Job YouTube demarre",
        jobId: job.jobId,
        status: job.status,
        fileName: job.fileName,
        filePath: job.filePath
    });
}

function runYouTubeJob(job) {
    const startedAt = Date.now();

    const fs = require("fs");
    const { getDb } = require("../services/sqlite.service");
    const db = getDb();

    function updateJobDb(patch) {
        const merged = { ...job, ...patch, updatedAt: Date.now() };
        Object.assign(job, merged);

        db.prepare(`
            UPDATE jobs SET status=?, progress=?, timemark=?, message=?, file_name=?,
                file_path=?, ffmpeg_mode=?, file_size_bytes=?, completed_at=?, duration_ms=?,
                error=?, updated_at=?
            WHERE job_id=?
        `).run(
            job.status, job.progress, job.timemark, job.message, job.fileName,
            job.filePath, job.ffmpegMode, job.fileSizeBytes, job.completedAt,
            job.durationMs, job.error, job.updatedAt, job.jobId
        );
        return job;
    }

    updateJobDb({ status: "running", startedAt, message: "Telechargement YouTube demarre" });

    downloadYouTubeVideo(job.url.replace("youtube:", ""), job.headers || {}, {
        onStart: () => {
            updateJobDb({ status: "running", message: "yt-dlp en cours" });
        },
        onProgress: (progress) => {
            const pct = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;
            updateJobDb({
                status: "running",
                progress: pct,
                timemark: progress.timemark || "",
                message: pct > 0 ? `YouTube ${pct}%` : "Traitement YouTube"
            });
        }
    }, {
        preferredName: job.preferredName || ""
    })
        .then((result) => {
            const completedAt = Date.now();
            let fileSizeBytes = 0;
            try {
                const stat = fs.statSync(result.outputPath);
                fileSizeBytes = stat.size;
            } catch (_e) { /* ignore */ }

            updateJobDb({
                status: "completed",
                progress: 100,
                completedAt,
                durationMs: startedAt ? completedAt - startedAt : 0,
                fileSizeBytes,
                message: "Telechargement YouTube termine",
                fileName: result.outputFileName,
                filePath: result.filePath,
                ffmpegMode: "yt-dlp"
            });
        })
        .catch((error) => {
            updateJobDb({
                status: "failed",
                completedAt: Date.now(),
                durationMs: startedAt ? Date.now() - startedAt : 0,
                message: "Echec YouTube",
                error: error.message || "Erreur yt-dlp"
            });
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
