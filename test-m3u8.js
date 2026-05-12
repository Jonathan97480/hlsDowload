const https = require("https");
const { getBestHlsUrl, parseM3u8 } = require("./src/services/hls-quality.service");

async function testM3u8() {
    try {
        const result = await getBestHlsUrl("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
        console.log("\n=== Analyse M3U8 ===");
        console.log(`URL originale: ${result.originalUrl}`);
        console.log(`Qualité trouvée: ${result.quality}`);
        console.log(`Meilleure URL: ${result.bestUrl}`);
        console.log(`Bandwidth: ${result.bandwidth} bps`);
        console.log(`Info complète:`, JSON.stringify(result.info, null, 2));
    } catch (error) {
        console.error("Erreur:", error.message);
    }
}

testM3u8();
