const { getBestHlsUrl, parseM3u8 } = require("./src/services/hls-quality.service");

async function testMasterM3U8() {
    try {
        const url = "https://prx-1351-ant-20.vmwesa.online/hls2/01/02374/vzsqpinb2r8e_,n,l,.urlset/master.m3u8?t=a71CBWb3nVRfnJn5VwpZSX7EuJlm6m4bKjGtLb7umvI=&s=1778527990&e=43200&v=&srv=bck-1493-u&i=0.4&sp=0&asn=3215";

        console.log("Analysing master M3U8...\n");
        const result = await getBestHlsUrl(url);

        console.log("✅ RESULTATS:");
        console.log(`Qualité détectée: ${result.quality}`);
        console.log(`Bandwith: ${result.bandwidth ? Math.round(result.bandwidth / 1000) + ' kbps' : 'unknown'}`);
        console.log(`\nMeilleure URL:`);
        console.log(`${result.bestUrl}`);

    } catch (error) {
        console.error("❌ Erreur:", error.message);
    }
}

testMasterM3U8();
