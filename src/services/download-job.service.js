const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { getSettings } = require("./admin-store.service");
const { getSystemMetrics } = require("./system-metrics.service");
const { getDb } = require("./sqlite.service");
const { ensureDiskSpaceForDownload } = require("./storage-guard.service");
const { downloadMediaToMp4, getDownloadSourceType } = require("./media-download.service");

const db = getDb();
const jobs = new Map();
const jobQueue = [];
const JOB_TTL_MS = 60 * 60 * 1000;
const HISTORY_LIMIT = 500;
let activeJobs = 0;

const upsertJobStatement = db.prepare(`
    INSERT INTO jobs (
        job_id, request_key, url, preferred_name, headers_json, status, progress,
        timemark, message, file_name, file_path, ffmpeg_mode, file_size_bytes, source_ip,
        client_id, user_agent, started_at, completed_at, duration_ms, error,
        updated_at, created_at
    ) VALUES (
        @jobId, @requestKey, @url, @preferredName, @headersJson, @status, @progress,
        @timemark, @message, @fileName, @filePath, @ffmpegMode, @fileSizeBytes, @sourceIp,
        @clientId, @userAgent, @startedAt, @completedAt, @durationMs, @error,
        @updatedAt, @createdAt
    )
    ON CONFLICT(job_id) DO UPDATE SET
        request_key = excluded.request_key,
        url = excluded.url,
        preferred_name = excluded.preferred_name,
        headers_json = excluded.headers_json,
        status = excluded.status,
        progress = excluded.progress,
        timemark = excluded.timemark,
        message = excluded.message,
        file_name = excluded.file_name,
        file_path = excluded.file_path,
        ffmpeg_mode = excluded.ffmpeg_mode,
        file_size_bytes = excluded.file_size_bytes,
        source_ip = excluded.source_ip,
        client_id = excluded.client_id,
        user_agent = excluded.user_agent,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms,
        error = excluded.error,
        updated_at = excluded.updated_at
`);

function parseHeaders(value) {
    if (!value) {
        return {};
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return {};
    }
}

function rowToJob(row) {
    return {
        jobId: row.job_id,
        requestKey: row.request_key || "",
        url: row.url,
        preferredName: row.preferred_name || "",
        headers: parseHeaders(row.headers_json),
        status: row.status,
        progress: row.progress || 0,
        timemark: row.timemark || "",
        message: row.message || "",
        fileName: row.file_name || "",
        filePath: row.file_path || "",
        ffmpegMode: row.ffmpeg_mode || "",
        fileSizeBytes: row.file_size_bytes || 0,
        sourceIp: row.source_ip || "",
        clientId: row.client_id || "",
        userAgent: row.user_agent || "",
        startedAt: row.started_at || 0,
        completedAt: row.completed_at || 0,
        durationMs: row.duration_ms || 0,
        error: row.error || "",
        updatedAt: row.updated_at || 0,
        createdAt: row.created_at || row.updated_at || 0
    };
}

function persistJob(job) {
    upsertJobStatement.run({
        jobId: job.jobId,
        requestKey: job.requestKey || "",
        url: job.url,
        preferredName: job.preferredName || "",
        headersJson: JSON.stringify(job.headers || {}),
        status: job.status || "queued",
        progress: Number.isFinite(job.progress) ? job.progress : 0,
        timemark: job.timemark || "",
        message: job.message || "",
        fileName: job.fileName || "",
        filePath: job.filePath || "",
        ffmpegMode: job.ffmpegMode || "",
        fileSizeBytes: Number.isFinite(job.fileSizeBytes) ? job.fileSizeBytes : 0,
        sourceIp: job.sourceIp || "",
        clientId: job.clientId || "",
        userAgent: job.userAgent || "",
        startedAt: job.startedAt || 0,
        completedAt: job.completedAt || 0,
        durationMs: job.durationMs || 0,
        error: job.error || "",
        updatedAt: job.updatedAt || Date.now(),
        createdAt: job.createdAt || Date.now()
    });
}

function trimHistoryRows() {
    db.prepare(`
        DELETE FROM jobs
        WHERE status IN ('completed', 'failed')
          AND job_id NOT IN (
              SELECT job_id FROM jobs
              WHERE status IN ('completed', 'failed')
              ORDER BY updated_at DESC
              LIMIT ?
          )
    `).run(HISTORY_LIMIT);
}

function cleanupOldJobs() {
    const now = Date.now();

    for (const [jobId, job] of jobs.entries()) {
        if (now - job.updatedAt > JOB_TTL_MS) {
            jobs.delete(jobId);
        }
    }
}

function createJob(url, preferredName = "") {
    cleanupOldJobs();

    const jobId = uuidv4();
    const now = Date.now();
    const job = {
        jobId,
        url,
        preferredName,
        status: "queued",
        progress: 0,
        timemark: "",
        message: "En attente",
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

    jobs.set(jobId, job);
    persistJob(job);
    return job;
}

function updateJob(jobId, patch) {
    const current = jobs.get(jobId);

    if (!current) {
        return null;
    }

    const next = {
        ...current,
        ...patch,
        updatedAt: Date.now()
    };

    jobs.set(jobId, next);
    persistJob(next);
    return next;
}

function getJob(jobId) {
    return jobs.get(jobId) || null;
}

function getJobsSnapshot() {
    const persistedRows = db.prepare(`
        SELECT * FROM jobs
        ORDER BY updated_at DESC
        LIMIT 200
    `).all();

    const merged = new Map(persistedRows.map((row) => {
        const job = rowToJob(row);
        return [job.jobId, job];
    }));

    for (const memoryJob of jobs.values()) {
        merged.set(memoryJob.jobId, memoryJob);
    }

    return Array.from(merged.values())
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 100);
}

function getHistorySnapshot() {
    const rows = db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('completed', 'failed')
        ORDER BY updated_at DESC
        LIMIT 100
    `).all();

    return rows.map(rowToJob);
}

function getLimit() {
    const settings = getSettings();
    const value = Number.parseInt(settings.maxConcurrentDownloads, 10);
    return Number.isFinite(value) && value > 0 ? value : 3;
}

function getCapacitySnapshot() {
    const maxConcurrentDownloads = getLimit();
    const activeDownloads = activeJobs;
    const queuedDownloads = jobQueue.length;

    return {
        maxConcurrentDownloads,
        activeDownloads,
        queuedDownloads,
        availableSlots: Math.max(0, maxConcurrentDownloads - activeDownloads)
    };
}

function queueJob(jobId) {
    if (!jobQueue.includes(jobId)) {
        jobQueue.push(jobId);
    }

    processQueue();
}

function processQueue() {
    const limit = getLimit();

    while (activeJobs < limit && jobQueue.length > 0) {
        const nextJobId = jobQueue.shift();
        const job = jobs.get(nextJobId);

        if (!job || job.status !== "queued") {
            continue;
        }

        startQueuedJob(job);
    }
}

function finalizeJob(jobId, patch) {
    const updated = updateJob(jobId, patch);

    if (updated && (updated.status === "completed" || updated.status === "failed")) {
        trimHistoryRows();
    }

    return updated;
}

function buildRequestKey({ url, headers, preferredName }) {
    return JSON.stringify({
        url,
        preferredName: preferredName || "",
        headers: {
            referer: headers?.referer || "",
            userAgent: headers?.userAgent || "",
            cookie: headers?.cookie || ""
        }
    });
}

function outputPathFromFilePath(filePath) {
    const fileName = path.basename(filePath || "");

    if (!fileName) {
        return "";
    }

    return path.resolve(__dirname, "../../downloads", fileName);
}

function isCompletedJobUsable(job) {
    if (!job || job.status !== "completed" || !job.filePath) {
        return false;
    }

    const outputPath = outputPathFromFilePath(job.filePath);
    return !!outputPath && fs.existsSync(outputPath);
}

function findReusableJob(requestKey) {
    for (const job of jobs.values()) {
        if (job.requestKey !== requestKey) {
            continue;
        }

        if (job.status === "queued" || job.status === "running") {
            return job;
        }

        if (isCompletedJobUsable(job)) {
            return job;
        }
    }

    const row = db.prepare(`
        SELECT * FROM jobs
        WHERE request_key = ? AND status = 'completed'
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(requestKey);

    if (row) {
        const persistentJob = rowToJob(row);
        if (isCompletedJobUsable(persistentJob)) {
            return persistentJob;
        }
    }

    return null;
}

function computeBandwidthMbps(job) {
    if (!job.fileSizeBytes || !job.durationMs) {
        return 0;
    }

    const seconds = job.durationMs / 1000;

    if (seconds <= 0) {
        return 0;
    }

    return Number(((job.fileSizeBytes * 8) / seconds / 1000000).toFixed(2));
}

function buildDashboardSnapshot() {
    const systemMetrics = getSystemMetrics();
    const jobList = getJobsSnapshot();
    const historyList = getHistorySnapshot();
    const completedHistory = historyList.filter((job) => job.status === "completed");
    const activeCount = jobList.filter((job) => job.status === "queued" || job.status === "running").length;
    const busyStatus = activeCount > 0 ? "Busy" : "Idle";
    const avgDurationMs = completedHistory.length > 0
        ? Math.round(completedHistory.reduce((total, job) => total + (job.durationMs || 0), 0) / completedHistory.length)
        : 0;
    const avgBandwidthMbps = completedHistory.length > 0
        ? Number((completedHistory.reduce((total, job) => total + computeBandwidthMbps(job), 0) / completedHistory.length).toFixed(2))
        : 0;

    const hourlyBandwidth = Array.from({ length: 12 }, (_, index) => {
        const bucketDate = new Date(Date.now() - ((11 - index) * 60 * 60 * 1000));
        const label = bucketDate.getHours().toString().padStart(2, "0");
        const bucketStart = bucketDate.getTime() - (bucketDate.getMinutes() * 60 * 1000) - (bucketDate.getSeconds() * 1000) - bucketDate.getMilliseconds();
        const bucketEnd = bucketStart + 60 * 60 * 1000;
        const bucketJobs = completedHistory.filter((job) => job.completedAt >= bucketStart && job.completedAt < bucketEnd);
        const throughput = bucketJobs.length > 0
            ? Number((bucketJobs.reduce((total, job) => total + computeBandwidthMbps(job), 0) / bucketJobs.length).toFixed(2))
            : 0;

        return {
            label: `${label}h`,
            value: throughput
        };
    });

    return {
        serverStatus: busyStatus,
        activeDownloads: activeCount,
        queuedDownloads: jobQueue.length,
        cpuPercent: systemMetrics.cpuPercent,
        memoryPercent: systemMetrics.memoryPercent,
        usedMemoryMb: systemMetrics.usedMemoryMb,
        totalMemoryMb: systemMetrics.totalMemoryMb,
        processMemoryMb: systemMetrics.processMemoryMb,
        averageProcessingMs: avgDurationMs,
        averageBandwidthMbps: avgBandwidthMbps,
        bandwidthSeries: hourlyBandwidth,
        jobs: jobList,
        history: historyList,
        totals: {
            completed: completedHistory.length,
            failed: historyList.filter((job) => job.status === "failed").length
        }
    };
}

function startQueuedJob(job) {
    const diskCheck = ensureDiskSpaceForDownload();

    if (!diskCheck.ok) {
        finalizeJob(job.jobId, {
            status: "failed",
            completedAt: Date.now(),
            durationMs: 0,
            message: "Espace disque insuffisant",
            error: diskCheck.message || "Espace disque insuffisant"
        });
        processQueue();
        return;
    }

    const startedAt = Date.now();
    activeJobs += 1;
    finalizeJob(job.jobId, {
        status: "running",
        startedAt,
        message: "Telechargement demarre"
    });

    const settings = getSettings();

    const sourceType = getDownloadSourceType(job.url);

    downloadMediaToMp4(job.url, job.headers || {}, {
        onStart: () => {
            finalizeJob(job.jobId, {
                status: "running",
                message: "Telechargement demarre"
            });
        },
        onProgress: (progress) => {
            const safePercent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, Math.round(progress.percent))) : 0;

            finalizeJob(job.jobId, {
                status: "running",
                progress: safePercent,
                timemark: progress.timemark || "",
                message: safePercent > 0 ? `Progression ${safePercent}%` : "Traitement en cours"
            });
        }
    }, {
        preferredName: job.preferredName || "",
        maxTitleLength: settings.maxTitleLength
    })
        .then((result) => {
            const completedAt = Date.now();
            const durationMs = startedAt ? completedAt - startedAt : 0;
            let fileSizeBytes = 0;

            try {
                const outputStat = fs.statSync(result.outputPath);
                fileSizeBytes = outputStat.size;
            } catch (_error) {
                fileSizeBytes = 0;
            }

            finalizeJob(job.jobId, {
                status: "completed",
                progress: 100,
                completedAt,
                durationMs,
                fileSizeBytes,
                message: `Telechargement termine (${result.quality || "default"})`,
                fileName: result.outputFileName,
                filePath: `/downloads/${result.outputFileName}`,
                ffmpegMode: result.mode || (sourceType === "direct" ? "direct" : "copy")
            });
        })
        .catch((error) => {
            finalizeJob(job.jobId, {
                status: "failed",
                completedAt: Date.now(),
                durationMs: startedAt ? Date.now() - startedAt : 0,
                message: "Echec du telechargement",
                error: error.message || "Erreur interne"
            });
        })
        .finally(() => {
            activeJobs = Math.max(0, activeJobs - 1);
            processQueue();
        });
}

function findCompletedDownload({ url, headers, preferredName }) {
    const requestKey = buildRequestKey({ url, headers, preferredName });
    const reusable = findReusableJob(requestKey);

    if (reusable && reusable.status === "completed") {
        return reusable;
    }

    return null;
}

function runDownloadJob({ url, headers, preferredName, maxTitleLength = 500, clientId = "", userAgent = "", ipAddress = "" }) {
    const requestKey = buildRequestKey({ url, headers, preferredName });
    const reusable = findReusableJob(requestKey);

    if (reusable) {
        return reusable;
    }

    const job = createJob(url, preferredName || "");
    updateJob(job.jobId, {
        requestKey,
        headers,
        maxTitleLength,
        clientId,
        userAgent,
        sourceIp: ipAddress
    });

    queueJob(job.jobId);

    return job;
}

function restorePendingJobsFromDatabase() {
    const rows = db.prepare(`
        SELECT * FROM jobs
        WHERE status IN ('queued', 'running')
        ORDER BY created_at ASC
        LIMIT 200
    `).all();

    for (const row of rows) {
        const job = rowToJob(row);

        jobs.set(job.jobId, job);
        updateJob(job.jobId, {
            status: "queued",
            message: "Repris apres redemarrage",
            error: ""
        });

        if (!jobQueue.includes(job.jobId)) {
            jobQueue.push(job.jobId);
        }
    }

    processQueue();
    return rows.length;
}

module.exports = {
    buildDashboardSnapshot,
    getCapacitySnapshot,
    getHistorySnapshot,
    runDownloadJob,
    getJob,
    getJobsSnapshot,
    findCompletedDownload,
    restorePendingJobsFromDatabase
};
