const https = require("https");
const http = require("http");

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https") ? https : http;

        protocol.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

async function extractM3U8() {
    try {
        const url = "https://voir-anime.to/anime/witch-hat-atelier-vf/witch-hat-atelier-07-vf/";
        console.log("Fetching page...");
        const html = await fetchPage(url);

        // Chercher les URLs M3U8
        const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
        const m3u8Matches = html.match(m3u8Regex);

        // Chercher les configurations JW Player
        const playerConfigRegex = /"file"\s*:\s*"([^"]+)"/g;
        let playerConfigs = [];
        let m;
        while ((m = playerConfigRegex.exec(html)) !== null) {
            if (m[1].includes("http")) {
                playerConfigs.push(m[1]);
            }
        }

        // Chercher les iframes
        const iframeRegex = /<iframe[^>]+src="([^"]+)"/g;
        let iframes = [];
        while ((m = iframeRegex.exec(html)) !== null) {
            iframes.push(m[1]);
        }

        // Chercher window.player ou configs
        const configRegex = /window\.player\s*=\s*({[^}]+})/;
        const configMatch = html.match(configRegex);

        console.log("\n=== RESULTATS ===\n");

        if (m3u8Matches) {
            console.log("URLs M3U8 trouvées:");
            m3u8Matches.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
        } else {
            console.log("❌ Aucune URL M3U8 trouvée");
        }

        if (playerConfigs.length > 0) {
            console.log("\nURLs des configurations JW Player:");
            playerConfigs.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
        }

        if (iframes.length > 0) {
            console.log("\nIframes trouvées:");
            iframes.forEach((url, i) => console.log(`  ${i + 1}. ${url.substring(0, 150)}`));
        }

        // Chercher des patterns spécifiques à Vidmoly
        if (html.includes("vidmoly") || html.includes("vmoly")) {
            console.log("\n⚠️  Lecteur Vidmoly détecté - l'URL est chargée dynamiquement");
            const vidmolyPattern = /vidmoly[^/]*/gi;
            const vidmoly = html.match(vidmolyPattern);
            if (vidmoly) console.log("Vidmoly ref:", vidmoly);
        }

    } catch (error) {
        console.error("Erreur:", error.message);
    }
}

extractM3U8();
