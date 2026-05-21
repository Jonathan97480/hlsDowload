(() => {
if (globalThis.__mediaUrlSenderContentScriptLoaded) {
    return;
}
globalThis.__mediaUrlSenderContentScriptLoaded = true;

    const PAGE_HOOK_EVENT = "media-url-sender:detected";
    const PAGE_HOOK_SOURCE = "media-url-sender";
    const RESCAN_DELAYS_MS = [0, 1200, 3000, 6000];
    let observerStarted = false;
    let pageHookInjected = false;

function getRuntimeSafe() {
    try {
        if (typeof chrome === "undefined" || !chrome.runtime) {
            return null;
        }

        if (!chrome.runtime.id) {
            return null;
        }

        return chrome.runtime;
    } catch (_error) {
        return null;
    }
}

function sendMessageSafe(payload) {
    const runtime = getRuntimeSafe();
    if (!runtime) {
        return Promise.resolve(null);
    }

    try {
        return runtime.sendMessage(payload).catch(() => null);
    } catch (_error) {
        return Promise.resolve(null);
    }
}

function isYouTubePage() {
    return /^https?:\/\/(www\.)?youtube\.com\/watch\?/i.test(document.location.href) ||
           /^https?:\/\/(www\.)?youtube\.com\/shorts\//i.test(document.location.href) ||
           /^https?:\/\/youtu\.be\//i.test(document.location.href);
}

function extractYouTubeVideoId() {
    const url = document.location.href;
    let match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    match = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    match = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    return "";
}

function notifyYouTubeDetection() {
    const videoId = extractYouTubeVideoId();
    if (!videoId) return;

    const title = document.querySelector("yt-formatted-string.ytd-watch-metadata h1, title, h1.ytd-watch-metadata");
    const videoTitle = title ? title.textContent.trim() : document.title || "";

    sendMessageSafe({
        type: "youtubeDetected",
        videoId,
        videoTitle,
        url: document.location.href,
        context: getPageContext("youtube")
    });
}

function getMediaCandidateKind(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
        return "";
    }

    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();
        const search = `${parsed.search}${parsed.hash}`.toLowerCase();
        const combined = `${pathname}${search}`;

        if (/\.m3u8(?:$|[?#])/i.test(url)) {
            return "hls_exact";
        }

        if (/\.mp4(?:$|[?#])/i.test(url)) {
            return "mp4_exact";
        }

        const blockedAssetExt = /\.(?:html?|css|js|json|txt|xml|jpg|jpeg|png|gif|svg|webp|ico|woff2?|ttf|map)$/i;
        if (blockedAssetExt.test(pathname)) {
            return "";
        }

        if (/(^|[/?=_-])(master|manifest|playlist|stream)([/?&=_-]|$)/.test(combined)) {
            return "hls_hint";
        }

        if (/(^|[?&=_-])(format|type|output|mime)=([^#]*m3u8|[^#]*mpegurl|[^#]*mp4)/.test(search)) {
            return /mp4/.test(search) ? "mp4_hint" : "hls_hint";
        }

        if (/(^|[?&=_-])(hls|m3u8|mp4)([=&/_-]|$)/.test(search)) {
            return /mp4/.test(search) ? "mp4_hint" : "hls_hint";
        }
    } catch (_error) {
        return "";
    }

    return "";
}

function isSupportedMediaUrl(url) {
    return !!getMediaCandidateKind(url);
}

function toAbsoluteMediaUrl(raw) {
    if (typeof raw !== "string") {
        return "";
    }

    const trimmed = raw.trim();
    if (!trimmed) {
        return "";
    }

    try {
        const resolved = new URL(trimmed, document.location.href).href;
        return isSupportedMediaUrl(resolved) ? resolved : "";
    } catch (_error) {
        return "";
    }
}

function isMasterLikeUrl(url) {
    const kind = getMediaCandidateKind(url);
    if (kind === "hls_hint") {
        return true;
    }

    let urlPath = "";
    try {
        urlPath = new URL(url, document.location.href).pathname.toLowerCase();
    } catch (_error) {
        return false;
    }

    return !/index-v\d+-a\d+|segment-\d+|variant[_-]\d+|quality[_-](360|480|720|1080)|seg-\d+/i.test(urlPath);
}

function getPageContext(source = "dom") {
    return {
        referer: document.referrer || document.location.href,
        userAgent: navigator.userAgent,
        documentUrl: document.location.href,
        source
    };
}

function rankCandidate(url) {
    return isMasterLikeUrl(url) ? 2 : 1;
}

function collectCandidates() {
    const candidates = new Map();
    const selectors = ["[src]", "[href]", "[data-url]", "[data-src]", "[data-m3u8]", "video", "source"];

    document.querySelectorAll(selectors.join(",")).forEach((element) => {
        ["src", "href", "data-url", "data-src", "data-m3u8"].forEach((attr) => {
            const url = toAbsoluteMediaUrl(element.getAttribute(attr));
            if (url && !candidates.has(url)) {
                candidates.set(url, rankCandidate(url));
            }
        });
    });

    const html = document.documentElement?.innerHTML || "";
    const absoluteMatches = html.match(/https?:[^\"'\s]+\.(?:m3u8|mp4)(?:\?[^\"'\s]*)?/gi) || [];
    const relativeMatches = html.match(/(?:^|[\"'\s])(\/[^\"'\s]+\.(?:m3u8|mp4)(?:\?[^\"'\s]*)?)/gi) || [];
    absoluteMatches.concat(relativeMatches.map((value) => value.trim())).forEach((rawUrl) => {
        const url = toAbsoluteMediaUrl(rawUrl);
        if (url && !candidates.has(url)) {
            candidates.set(url, rankCandidate(url));
        }
    });

    return Array.from(candidates.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([url]) => url)
        .slice(0, 20);
}

function pushUrl(url, source = "dom", extras = {}) {
    const safeUrl = toAbsoluteMediaUrl(url);
    if (!safeUrl) {
        return false;
    }

    sendMessageSafe({
        type: "captureUrl",
        url: safeUrl,
        context: {
            ...getPageContext(source),
            ...extras
        }
    });

    return true;
}

function pushCandidatesToBackground(source = "dom-scan") {
    const found = collectCandidates();
    found.forEach((url) => pushUrl(url, source));
    return found;
}

function scheduleRescans() {
    RESCAN_DELAYS_MS.forEach((delayMs) => {
        window.setTimeout(() => {
            pushCandidatesToBackground(delayMs === 0 ? "dom-initial" : "dom-delayed");
        }, delayMs);
    });
}

function startMutationObserver() {
    if (observerStarted || !document.documentElement) {
        return;
    }

    let queued = false;
    const observer = new MutationObserver(() => {
        if (queued) {
            return;
        }

        queued = true;
        window.setTimeout(() => {
            queued = false;
            pushCandidatesToBackground("dom-mutation");
        }, 400);
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "href", "data-url", "data-src", "data-m3u8"]
    });

    observerStarted = true;
}

function injectPageHook() {
    if (pageHookInjected || !document.documentElement) {
        return;
    }

    const runtime = getRuntimeSafe();
    if (!runtime) {
        return;
    }

    const script = document.createElement("script");
    try {
        script.src = runtime.getURL("page-hook.js");
    } catch (_error) {
        return;
    }
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
    pageHookInjected = true;
}

    window.addEventListener(PAGE_HOOK_EVENT, (event) => {
        const detail = event.detail || {};
        if (detail.source !== PAGE_HOOK_SOURCE) {
            return;
        }

        pushUrl(detail.url, detail.channel || "page-hook", {
            method: detail.method || "",
            initiator: detail.initiator || document.location.href
        });
    });

    injectPageHook();
    scheduleRescans();
    startMutationObserver();

    if (isYouTubePage()) {
        notifyYouTubeDetection();
        setTimeout(notifyYouTubeDetection, 2000);
        setTimeout(notifyYouTubeDetection, 5000);
    }

    const runtime = getRuntimeSafe();
    if (runtime && runtime.onMessage && typeof runtime.onMessage.addListener === "function") {
        runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type === "scanPage") {
                const found = pushCandidatesToBackground("manual-scan");
                sendResponse({ ok: true, found, context: getPageContext("manual-scan") });
                return undefined;
            }

            if (message?.type === "checkYouTube") {
                const isYT = isYouTubePage();
                const videoId = isYT ? extractYouTubeVideoId() : "";
                sendResponse({ ok: true, isYouTube: isYT, videoId });
                return undefined;
            }

            return undefined;
        });
    }
})();
