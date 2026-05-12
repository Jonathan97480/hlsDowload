const https = require("https");
const http = require("http");

function parseM3u8(content) {
    const variants = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith("#EXT-X-STREAM-INF:")) {
            const attrs = line.substring("#EXT-X-STREAM-INF:".length);
            const nextLine = lines[i + 1]?.trim();

            if (!nextLine || nextLine.startsWith("#")) {
                continue;
            }

            const resolution = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
            const bandwidth = attrs.match(/BANDWIDTH=(\d+)/);

            variants.push({
                url: nextLine,
                resolution: resolution ? { width: parseInt(resolution[1]), height: parseInt(resolution[2]) } : null,
                bandwidth: bandwidth ? parseInt(bandwidth[1]) : 0,
                pixels: resolution ? parseInt(resolution[1]) * parseInt(resolution[2]) : 0
            });
        }
    }

    return variants;
}

function fetchM3u8(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https") ? https : http;

        const defaultHeaders = { "User-Agent": "Mozilla/5.0" };
        const mergedHeaders = { ...defaultHeaders, ...headers };

        protocol.get(url, { headers: mergedHeaders }, (res) => {
            let data = "";

            res.on("data", (chunk) => {
                data += chunk;
            });

            res.on("end", () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        }).on("error", reject);
    });
}

function selectBestVariant(variants) {
    if (!variants || variants.length === 0) {
        return null;
    }

    return variants.reduce((best, current) => {
        if (!best) return current;
        if (current.pixels > best.pixels) return current;
        if (current.pixels === best.pixels && current.bandwidth > best.bandwidth) return current;
        return best;
    });
}

async function getBestHlsUrl(sourceUrl, headers = {}) {
    try {
        const m3u8Content = await fetchM3u8(sourceUrl, headers);
        const variants = parseM3u8(m3u8Content);

        // Si pas de variantes, c'est une media playlist directe
        if (!variants || variants.length === 0) {
            console.log(`[hls-quality] Aucune variante trouvée - media playlist directe`);
            return { originalUrl: sourceUrl, quality: "direct", bestUrl: sourceUrl };
        }

        const best = selectBestVariant(variants);

        if (!best) {
            return { originalUrl: sourceUrl, quality: "unknown" };
        }

        const bestUrl = best.url.startsWith("http") ? best.url : new URL(best.url, sourceUrl).href;
        const qualityStr = best.resolution ? `${best.resolution.width}x${best.resolution.height}` : "unknown";

        console.log(`[hls-quality] Variantes trouvées: ${variants.length}`);
        console.log(`[hls-quality] Meilleure: ${qualityStr} | ${Math.round(best.bandwidth / 1000)} kbps`);

        return {
            originalUrl: sourceUrl,
            bestUrl,
            quality: qualityStr,
            bandwidth: best.bandwidth,
            info: best
        };
    } catch (error) {
        console.error(`[hls-quality] Erreur parsing M3U8: ${error.message}`);
        console.log(`[hls-quality] Fallback - utilisation URL directe`);
        return { originalUrl: sourceUrl, quality: "fallback", bestUrl: sourceUrl };
    }
}

module.exports = { getBestHlsUrl, parseM3u8, selectBestVariant };
