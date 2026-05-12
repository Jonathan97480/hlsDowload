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
        // Utilise l'URL du dernier test
        const url = "https://prx-1357-ant-v.vmwesa.online/hls2/01/02374/vzsqpinb2r8e_l/index-v1-a1.m3u8?t=g3GT0ua-9mZuACAng1mClqQ2cs9EHVccpcopEEKcFLM=&s=1778525280&e=43200&v=&srv=bck-1493-u&i=0.4&sp=0&asn=3215";
        console.log(`Fetching: ${url}\n`);
        const content = await fetchUrl(url);
        const lines = content.split("\n").slice(0, 100);

        console.log("=== Contenu brut du M3U8 ===\n");
        lines.forEach((line, i) => {
            console.log(`${i + 1}: ${line}`);
        });

        console.log("\n=== Analyse ===");
        console.log(`Total lignes: ${content.split("\n").length}`);
        console.log(`Contient STREAM-INF: ${content.includes("STREAM-INF") ? "OUI" : "NON"}`);
        console.log(`Contient RESOLUTION: ${content.includes("RESOLUTION") ? "OUI" : "NON"}`);
        console.log(`Contient EXT-X-STREAM-INF: ${content.includes("EXT-X-STREAM-INF") ? "OUI" : "NON"}`);
    } catch (error) {
        console.error("Erreur:", error.message);
    }
}

test();
