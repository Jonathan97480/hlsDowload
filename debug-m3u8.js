const https = require("https");

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
        const url = "https://test-streams.mux.dev/x36xhzz/url_8/193039199_mp4_h264_aac_fhd_7.m3u8";
        console.log(`Fetching: ${url}\n`);
        const content = await fetchUrl(url);
        const lines = content.split("\n").slice(0, 30);
        lines.forEach((line, i) => {
            console.log(`${i + 1}: ${line}`);
        });
    } catch (error) {
        console.error("Erreur:", error.message);
    }
}

test();
