const { fetchHlsText, mergeHeaders } = require("./hls-http.service");

function isMasterPlaylist(content) {
    return /EXT-X-STREAM-INF|#EXT-X-STREAM-INF/i.test(content);
}

function guessMatsterUrl(url) {
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const dir = path.substring(0, path.lastIndexOf('/')) || '/';

        const attempts = [];
        const pushAttempt = (nextPath, keepQuery = true) => {
            if (!nextPath || typeof nextPath !== "string") {
                return;
            }

            const built = new URL(nextPath, urlObj.origin);
            if (keepQuery && urlObj.search) {
                built.search = urlObj.search;
            }

            const href = built.href;
            if (!attempts.includes(href) && href !== urlObj.href) {
                attempts.push(href);
            }
        };

        // Pattern 1: index-v1-a1.m3u8 -> master.m3u8
        let attempt = path.replace(/index-v\d+-a\d+\.m3u8/i, "master.m3u8");
        if (attempt !== path) {
            pushAttempt(attempt);
        }

        // Pattern 2: index-v1-a1.m3u8 -> index.m3u8 (just remove variant suffix)
        attempt = path.replace(/index-v\d+-a\d+\.m3u8/i, "index.m3u8");
        if (attempt !== path) {
            pushAttempt(attempt);
        }

        // Pattern 3: Try other common master names
        const masterNames = ["master.m3u8", "manifest.m3u8", "playlist.m3u8", "main.m3u8", "stream.m3u8"];
        masterNames.forEach((name) => {
            const masterPath = dir + "/" + name;
            pushAttempt(masterPath);
        });

        // Pattern 4: Generic replacement (file.m3u8 -> master.m3u8)
        attempt = path.replace(/[^/]+\.m3u8$/i, "master.m3u8");
        if (attempt !== path) {
            pushAttempt(attempt);
        }

        // Pattern 5: Remove any query parameters and try to detect master without them
        // (sometimes the base path matters more than query string)
        if (urlObj.search) {
            const baseAttempt = path.replace(/index-v\d+-a\d+\.m3u8/i, "master.m3u8");
            if (baseAttempt !== path) {
                pushAttempt(baseAttempt, false);
            }
        }

        // Return attempts in order (will be tried sequentially by caller)
        return attempts.length > 0 ? attempts : null;
    } catch (error) {
        return null;
    }
}

async function findMasterM3U8(sourceUrl, headers = {}) {
    console.log(`[master-detector] Analyse: ${sourceUrl}`);

    if (Object.keys(headers).length > 0) {
        console.log(`[master-detector] 📋 Headers fournis: ${Object.keys(headers).join(", ")}`);
        console.log(`[master-detector] 📤 Headers: ${JSON.stringify(Object.keys(mergeHeaders(headers)))}`);
    }

    try {
        // Essai 1: Fetch l'URL fournie
        console.log(`[master-detector] Fetch #1: URL originale`);
        const content1 = await fetchHlsText(sourceUrl, headers);

        const variants1 = (content1.match(/#EXT-X-STREAM-INF/g) || []).length;
        console.log(`[master-detector] ℹ️  Variantes trouvées: ${variants1}`);

        if (isMasterPlaylist(content1)) {
            console.log(`[master-detector] ✅ URL originale est un master`);
            return { url: sourceUrl, isMaster: true, method: "original" };
        }

        console.log(`[master-detector] ℹ️  URL originale n'est pas un master - tentative de transformation`);

        // Essai 2+: Essayer toutes les variantes devinees
        const guessedUrls = guessMatsterUrl(sourceUrl);
        if (Array.isArray(guessedUrls) && guessedUrls.length > 0) {
            let attemptNum = 2;
            for (const guessedUrl of guessedUrls) {
                console.log(`[master-detector] Fetch #${attemptNum}: URL devinee: ${guessedUrl}`);
                try {
                    const guessedContent = await fetchHlsText(guessedUrl, headers);

                    if (isMasterPlaylist(guessedContent)) {
                        console.log(`[master-detector] ✅ URL devinee est un master`);
                        return { url: guessedUrl, isMaster: true, method: "guessed" };
                    }

                    const variantCount = (guessedContent.match(/#EXT-X-STREAM-INF/g) || []).length;
                    console.log(`[master-detector] ℹ️  Tentative #${attemptNum} non-master (${variantCount} variantes)`);
                } catch (guessError) {
                    console.log(`[master-detector] ⚠️  Erreur acces URL #${attemptNum}: ${guessError.message}`);
                }

                attemptNum += 1;
            }
        }

        // Essai final: Fallback - utiliser l'URL originale
        console.log(`[master-detector] ⚠️  Fallback: utilisation URL originale (non-master)`);
        return { url: sourceUrl, isMaster: false, method: "fallback" };
    } catch (error) {
        console.log(`[master-detector] ❌ Erreur: ${error.message}`);
        // Fallback ultime
        return { url: sourceUrl, isMaster: false, method: "error-fallback", error: error.message };
    }
}

module.exports = { findMasterM3U8, isMasterPlaylist, guessMatsterUrl };
