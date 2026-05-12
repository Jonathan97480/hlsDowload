const https = require("https");
const { parseM3u8 } = require("./src/services/hls-quality.service");

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

async function test() {
    try {
        const masterUrl = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
        console.log(`Fetching master: ${masterUrl}\n`);
        const content = await fetchUrl(masterUrl);
        const variants = parseM3u8(content);

        console.log(`=== ${variants.length} variantes trouvées ===\n`);
        variants.forEach((v, i) => {
            const res = v.resolution ? `${v.resolution.width}x${v.resolution.height}` : "unknown";
            const bw = v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : "unknown";
            console.log(`${i + 1}. ${res} | ${bw} | ${v.url}`);
        });
    } catch (error) {
        console.error("Erreur:", error.message);
    }
}

test();
