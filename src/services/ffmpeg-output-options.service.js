function buildCopyOutputOptions() {
    return [
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart"
    ];
}

function buildAudioResyncFilter(syncProfile = "soft") {
    if (syncProfile === "aggressive") {
        return "aresample=async=1:first_pts=0";
    }

    if (syncProfile === "gentle") {
        return "aresample=async=120:min_comp=0.001:min_hard_comp=0.050000:first_pts=0";
    }

    return "aresample=async=40:min_comp=0.001:min_hard_comp=0.020000:first_pts=0";
}

function buildStableTranscodeOutputOptions(syncProfile = "soft") {
    return [
        "-fflags",
        "+genpts",
        "-vsync",
        "cfr",
        "-af",
        buildAudioResyncFilter(syncProfile),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero"
    ];
}

function buildVideoTranscodeCopyAudioOutputOptions() {
    return [
        "-fflags",
        "+genpts",
        "-vsync",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-avoid_negative_ts",
        "make_zero"
    ];
}

module.exports = {
    buildCopyOutputOptions,
    buildAudioResyncFilter,
    buildStableTranscodeOutputOptions,
    buildVideoTranscodeCopyAudioOutputOptions
};
