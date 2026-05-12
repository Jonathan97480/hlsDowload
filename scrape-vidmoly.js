const https = require("https");

function fetchPage(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.7444.265",
                "Referer": "https://voir-anime.to/"
            }
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

async function extractM3U8FromEmbed() {
    try {
        const embedUrl = "https://vidmoly.biz/embed-vzsqpinb2r8e.html";
        console.log(`Fetching embed page: ${embedUrl}\n`);
        const html = await fetchPage(embedUrl);

        // Chercher les URLs M3U8
        const m3u8Regex = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g;
        const m3u8Matches = html.match(m3u8Regex);

        // Chercher les sources vidéo
        const sourceRegex = /<source[^>]+src="([^"]+)"/g;
        let sources = [];
        let m;
        while ((m = sourceRegex.exec(html)) !== null) {
            sources.push(m[1]);
        }

        // Chercher les configurations
        const configRegex = /"file"\s*:\s*"([^"]+)"/g;
        let configs = [];
        while ((m = configRegex.exec(html)) !== null) {
            configs.push(m[1]);
        }

        // Chercher les URLs en JSON
        const jsonRegex = /"src"\s*:\s*"([^"]+)"/g;
        let jsonUrls = [];
        while ((m = jsonRegex.exec(html)) !== null) {
            jsonUrls.push(m[1]);
        }

        console.log("=== RESULTATS ===\n");

        if (m3u8Matches) {
            console.log("✅ URLs M3U8 trouvées:");
            m3u8Matches.forEach((url, i) => {
                console.log(`  ${i + 1}. ${url}`);
            });
        }

        if (sources.length > 0) {
            console.log("\nURLs sources vidéo:");
            sources.forEach((url, i) => {
                console.log(`  ${i + 1}. ${url.substring(0, 200)}`);
            });
        }

        if (configs.length > 0) {
            console.log("\nURLs de configuration:");
            configs.forEach((url, i) => {
                console.log(`  ${i + 1}. ${url.substring(0, 200)}`);
            });
        }

        if (jsonUrls.length > 0) {
            console.log("\nURLs JSON:");
            jsonUrls.forEach((url, i) => {
                console.log(`  ${i + 1}. ${url.substring(0, 200)}`);
            });
        }

        console.log(`\n📊 Page length: ${html.length} bytes`);

        // Chercher si l'URL est encodée ou dans un script
        if (html.includes("base64")) {
            console.log("⚠️  URL probablement encodée en Base64");
        }
        if (html.includes("atob") || html.includes("btoa")) {
            console.log("⚠️  Décodage JavaScript détecté");
        }

    } catch (error) {
        console.error("Erreur:", error.message);
    }
}

extractM3U8FromEmbed();
