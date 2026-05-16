const { getDb } = require("./sqlite.service");

const db = getDb();
const STATE_KEY = "hls_segment_stats";
const DEFAULT_STATS = {
    totalSegments: 0,
    corruptedSegments: 0,
    retryAttempts: 0,
    updatedAt: 0
};

function readStats() {
    const row = db.prepare("SELECT value_text FROM app_state WHERE key = ?").get(STATE_KEY);

    if (!row?.value_text) {
        return { ...DEFAULT_STATS };
    }

    try {
        const parsed = JSON.parse(row.value_text);
        return {
            totalSegments: Number.isFinite(parsed.totalSegments) ? parsed.totalSegments : 0,
            corruptedSegments: Number.isFinite(parsed.corruptedSegments) ? parsed.corruptedSegments : 0,
            retryAttempts: Number.isFinite(parsed.retryAttempts) ? parsed.retryAttempts : 0,
            updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0
        };
    } catch (_error) {
        return { ...DEFAULT_STATS };
    }
}

function writeStats(stats) {
    const nextStats = {
        totalSegments: Math.max(0, Number.parseInt(stats.totalSegments, 10) || 0),
        corruptedSegments: Math.max(0, Number.parseInt(stats.corruptedSegments, 10) || 0),
        retryAttempts: Math.max(0, Number.parseInt(stats.retryAttempts, 10) || 0),
        updatedAt: Date.now()
    };

    db.prepare(`
        INSERT INTO app_state (key, value_text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value_text = excluded.value_text,
            updated_at = excluded.updated_at
    `).run(STATE_KEY, JSON.stringify(nextStats), nextStats.updatedAt);

    return nextStats;
}

function updateStats(mutator) {
    const current = readStats();
    const next = mutator({ ...current }) || current;
    return writeStats(next);
}

function recordSegmentDownloaded() {
    return updateStats((stats) => {
        stats.totalSegments += 1;
        return stats;
    });
}

function recordSegmentCorrupted() {
    return updateStats((stats) => {
        stats.corruptedSegments += 1;
        return stats;
    });
}

function recordSegmentRetry() {
    return updateStats((stats) => {
        stats.retryAttempts += 1;
        return stats;
    });
}

function getSegmentStats() {
    return readStats();
}

module.exports = {
    getSegmentStats,
    recordSegmentCorrupted,
    recordSegmentDownloaded,
    recordSegmentRetry
};
