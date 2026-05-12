function isHlsUrl(url) {
    return /^https?:\/\//i.test(url) && /\.m3u8(\?.*)?$/i.test(url);
}

function toAbsoluteHlsUrl(raw) {
    if (typeof raw !== "string") {
        return "";
    }

    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }

    try {
        const resolved = new URL(trimmed, document.location.href).href;
        return isHlsUrl(resolved) ? resolved : "";
    } catch (_error) {
        return "";
    }
}

function isMasterLikeUrl(url) {
    // Chercher des patterns qui indiquent un master M3U8
    // Exclure les URLs avec patterns de variantes comme "index-v1-a1", "index-vX-aX"
    let urlPath = "";
    try {
        urlPath = new URL(url, document.location.href).pathname.toLowerCase();
    } catch (_error) {
        return false;
    }

    const hasVariantPattern = /index-v\d+-a\d+|segment-\d+|variant[_-]\d+|quality[_-](360|480|720|1080)/i.test(urlPath);
    return !hasVariantPattern;
}

function getPageContext() {
    return {
        referer: document.referrer || document.location.href,
        userAgent: navigator.userAgent,
        documentUrl: document.location.href
    };
}

function collectCandidates() {
    const candidates = new Set();
    const masterUrls = new Set(); // Chercher d'abord les masters

    // Scan DOM pour m3u8 dans les attributs
    document.querySelectorAll("[src], [href], [data-url], [data-src], [data-m3u8]").forEach((element) => {
        ["src", "href", "data-url", "data-src", "data-m3u8"].forEach((attr) => {
            const val = element.getAttribute(attr);
            const url = toAbsoluteHlsUrl(val);
            if (url) {
                if (isMasterLikeUrl(url)) {
                    masterUrls.add(url);
                } else {
                    candidates.add(url);
                }
            }
        });
    });

    // Scan HTML pour m3u8 dans le texte/scripts
    const html = document.documentElement?.innerHTML || "";
    const absoluteMatches = html.match(/https?:[^\"'\s]+\.m3u8(?:\?[^\"'\s]*)?/gi) || [];
    const relativeMatches = html.match(/(?:^|[\"'\s])(\/[^\"'\s]+\.m3u8(?:\?[^\"'\s]*)?)/gi) || [];
    const matches = absoluteMatches.concat(relativeMatches.map((v) => v.trim()));

    matches.forEach((rawUrl) => {
        const url = toAbsoluteHlsUrl(rawUrl);
        if (url) {
            if (isMasterLikeUrl(url)) {
                masterUrls.add(url);
            } else {
                candidates.add(url);
            }
        }
    });

    // Priorité: masters d'abord, puis variantes
    const all = Array.from(masterUrls).concat(Array.from(candidates));
    return all.slice(0, 20);
}

function pushCandidatesToBackground() {
    const found = collectCandidates();
    const context = getPageContext();

    found.forEach((url) => {
        chrome.runtime.sendMessage({ type: "captureUrl", url, context });
    });

    return found;
}

pushCandidatesToBackground();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "scanPage") {
        const found = pushCandidatesToBackground();
        const context = getPageContext();
        sendResponse({ ok: true, found, context });
    }
});
