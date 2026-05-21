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

function buildStableTranscodeOutputOptions() {
    return [
        "-fflags",
        "+genpts",
        "-vsync",
        "cfr",
        "-af",
        "aresample=async=1:first_pts=0",
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

module.exports = {
    buildCopyOutputOptions,
    buildStableTranscodeOutputOptions
};
