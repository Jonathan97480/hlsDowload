function extractExtinfDurations(lines) {
    return lines
        .filter((line) => line.startsWith("#EXTINF:"))
        .map((line) => Number.parseFloat(line.slice(8)))
        .filter((value) => Number.isFinite(value) && value > 0);
}

function extractTargetDuration(lines) {
    const line = lines.find((entry) => entry.startsWith("#EXT-X-TARGETDURATION:"));
    if (!line) {
        return null;
    }

    const value = Number.parseFloat(line.split(":")[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function analyseDurationSpread(durations) {
    if (durations.length < 2) {
        return { min: null, max: null, spread: 0 };
    }

    const min = Math.min(...durations);
    const max = Math.max(...durations);

    return {
        min,
        max,
        spread: max - min
    };
}

function detectPlaylistType(lines) {
    const hasEndList = lines.some((line) => line.startsWith("#EXT-X-ENDLIST"));
    const playlistTypeLine = lines.find((line) => line.startsWith("#EXT-X-PLAYLIST-TYPE:"));
    const declaredType = playlistTypeLine ? String(playlistTypeLine.split(":")[1] || "").trim().toUpperCase() : "";

    if (declaredType === "VOD") {
        return "vod";
    }

    if (declaredType === "EVENT") {
        return "event";
    }

    return hasEndList ? "vod" : "live";
}

function analyzePlaylist(lines) {
    const targetDuration = extractTargetDuration(lines);
    const durations = extractExtinfDurations(lines);
    const durationStats = analyseDurationSpread(durations);
    const playlistType = detectPlaylistType(lines);
    const hasDiscontinuity = lines.some((line) => line.startsWith("#EXT-X-DISCONTINUITY"));
    const hasProgramDateTime = lines.some((line) => line.startsWith("#EXT-X-PROGRAM-DATE-TIME"));
    const spreadThreshold = targetDuration ? Math.max(0.75, targetDuration * 0.35) : 1.5;
    const hasVariableDurations = durationStats.spread > spreadThreshold;
    const requiresAggressiveAudioSync = hasDiscontinuity;
    // Certaines playlists horodatees derivent meme en VOD une fois remuxe/concatenees.
    const isLikelyUnstable = hasDiscontinuity || hasVariableDurations || hasProgramDateTime;
    const isLiveLike = playlistType === "live" || playlistType === "event";

    return {
        playlistType,
        isLiveLike,
        hasDiscontinuity,
        hasProgramDateTime,
        hasVariableDurations,
        requiresAggressiveAudioSync,
        isLikelyUnstable,
        recommendedConcatMode: isLiveLike || isLikelyUnstable ? "transcode" : "copy",
        recommendedAudioSyncProfile: isLiveLike || requiresAggressiveAudioSync ? "aggressive" : "soft",
        targetDuration,
        segmentCount: durations.length,
        durationSpread: durationStats.spread
    };
}

module.exports = {
    analyzePlaylist
};
