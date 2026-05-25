const { parseMasterPlaylist } = require("./hls-master-playlist.service");
const { fetchHlsText } = require("./hls-http.service");
const { analyzePlaylist } = require("./hls-playlist-analysis.service");

function parseM3u8(content) {
    return parseMasterPlaylist(content).variants;
}

function analyzeMediaPlaylistContent(content) {
    const lines = String(content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return analyzePlaylist(lines);
}

function selectBestVariant(variants) {
    if (!variants || variants.length === 0) {
        return null;
    }

    const playableVariants = variants.filter((variant) => variant.hasUsableAudio);
    const candidates = playableVariants.length > 0 ? playableVariants : variants;

    return candidates.reduce((best, current) => {
        if (!best) return current;
        if (current.pixels > best.pixels) return current;
        if (current.pixels === best.pixels && current.bandwidth > best.bandwidth) return current;
        return best;
    });
}

async function getBestHlsUrl(sourceUrl, headers = {}) {
    try {
        const m3u8Content = await fetchHlsText(sourceUrl, headers);
        const variants = parseM3u8(m3u8Content);

        // Si pas de variantes, c'est une media playlist directe
        if (!variants || variants.length === 0) {
            console.log(`[hls-quality] Aucune variante trouvée - media playlist directe`);
            const playlistAnalysis = analyzeMediaPlaylistContent(m3u8Content);
            return {
                originalUrl: sourceUrl,
                quality: "direct",
                bestUrl: sourceUrl,
                playlistAnalysis,
                playlistType: playlistAnalysis.playlistType,
                isLiveLike: playlistAnalysis.isLiveLike
            };
        }

        const best = selectBestVariant(variants);

        if (!best) {
            return { originalUrl: sourceUrl, quality: "unknown" };
        }

        const bestUrl = best.url.startsWith("http") ? best.url : new URL(best.url, sourceUrl).href;
        const qualityStr = best.resolution ? `${best.resolution.width}x${best.resolution.height}` : "unknown";
        const requiresExternalAudio = Boolean(best.requiresExternalAudio);
        const selectedUrl = requiresExternalAudio ? sourceUrl : bestUrl;
        const delivery = requiresExternalAudio ? "master-with-audio-group" : "media-playlist";

        console.log(`[hls-quality] Variantes trouvées: ${variants.length}`);
        console.log(`[hls-quality] Meilleure: ${qualityStr} | ${Math.round(best.bandwidth / 1000)} kbps | ${delivery}`);

        return {
            originalUrl: sourceUrl,
            bestUrl: selectedUrl,
            quality: qualityStr,
            bandwidth: best.bandwidth,
            requiresExternalAudio,
            delivery,
            skipSegmentPipeline: requiresExternalAudio,
            playlistAnalysis: analyzeMediaPlaylistContent(await fetchHlsText(selectedUrl, headers).catch(() => "")),
            info: best
        };
    } catch (error) {
        console.error(`[hls-quality] Erreur parsing M3U8: ${error.message}`);
        console.log(`[hls-quality] Fallback - utilisation URL directe`);
        return { originalUrl: sourceUrl, quality: "fallback", bestUrl: sourceUrl };
    }
}

module.exports = { getBestHlsUrl, parseM3u8, selectBestVariant };
