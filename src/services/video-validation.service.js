const { spawn } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");

if (process.env.FFMPEG_PATH) {
    ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

function verifySegmentIntegrity(segmentPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(segmentPath).ffprobe((error, data) => {
            if (error) {
                reject(new Error(`Segment verification failed: ${error.message}`));
                return;
            }

            const streams = Array.isArray(data?.streams) ? data.streams : [];
            const hasMediaStream = streams.some((stream) => stream.codec_type === "video" || stream.codec_type === "audio");
            const fileSize = Number.parseInt(data?.format?.size, 10);
            const hasPayload = Number.isFinite(fileSize) ? fileSize > 0 : true;

            // Many TS segments do not expose a reliable standalone duration in ffprobe.
            // Accept them when they contain at least one media stream and non-empty payload.
            if (hasMediaStream && hasPayload) {
                resolve(true);
                return;
            }

            reject(new Error("Segment media stream is invalid."));
        });
    });
}

function validateWithFfprobe(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (error, metadata) => {
            if (error) {
                reject(new Error(`ffprobe indisponible: ${error.message}`));
                return;
            }

            const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
            const hasVideo = streams.some((stream) => stream.codec_type === "video");
            const hasAudio = streams.some((stream) => stream.codec_type === "audio");
            const videoStream = streams.find((stream) => stream.codec_type === "video");
            const audioStream = streams.find((stream) => stream.codec_type === "audio");
            const videoDuration = Number.parseFloat(videoStream?.duration || metadata?.format?.duration);
            const audioDuration = Number.parseFloat(audioStream?.duration || metadata?.format?.duration);

            if (!hasVideo) {
                reject(new Error("Aucun flux video detecte dans le MP4"));
                return;
            }

            if (!hasAudio) {
                reject(new Error("Aucun flux audio detecte dans le MP4"));
                return;
            }

            if (Number.isFinite(videoDuration) && Number.isFinite(audioDuration)) {
                const durationGap = Math.abs(videoDuration - audioDuration);
                if (durationGap > Math.max(1.5, videoDuration * 0.05)) {
                    reject(new Error(`Desynchronisation audio/video detectee (${durationGap.toFixed(2)}s)`));
                    return;
                }
            }

            resolve(metadata);
        });
    });
}

function validateDecodePass(filePath, mode = "av") {
    return new Promise((resolve, reject) => {
        const ffmpegBin = process.env.FFMPEG_PATH || "ffmpeg";
        const args = ["-v", "error", "-i", filePath, "-t", "120"];
        if (mode === "audio") {
            args.push("-vn");
        }
        args.push("-f", "null", "-");
        const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            reject(new Error(`Validation ffmpeg impossible: ${error.message}`));
        });

        child.on("close", (code) => {
            if (code === 0 && !stderr.trim()) {
                resolve();
                return;
            }

            reject(new Error(`Decode check en echec: ${stderr.trim() || `exit ${code}`}`));
        });
    });
}

async function validateOutputFile(filePath) {
    await validateWithFfprobe(filePath);
    await validateDecodePass(filePath, "av");
    await validateDecodePass(filePath, "audio");
}

module.exports = {
    validateOutputFile,
    verifySegmentIntegrity
};
