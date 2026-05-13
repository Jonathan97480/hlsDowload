const PAGE_HOOK_EVENT = "media-url-sender:detected";
const PAGE_HOOK_SOURCE = "media-url-sender";
const RESCAN_DELAYS_MS = [0, 1200, 3000, 6000];
let observerStarted = false;
let pageHookInjected = false;

function isSupportedMediaUrl(url) {
    return /^https?:\/\//i.test(url) && /\.(m3u8|mp4)(\?.*)?$/i.test(url);
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
    let urlPath = "";
    try {
        urlPath = new URL(url, document.location.href).pathname.toLowerCase();
    } catch (_error) {
        return false;
    }

    return !/index-v\d+-a\d+|segment-\d+|variant[_-]\d+|quality[_-](360|480|720|1080)/i.test(urlPath);
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

    chrome.runtime.sendMessage({
        type: "captureUrl",
        url: safeUrl,
        context: {
            ...getPageContext(source),
            ...extras
        }
    }).catch(() => { });

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

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-hook.js");
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "scanPage") {
        return undefined;
    }

    const found = pushCandidatesToBackground("manual-scan");
    sendResponse({ ok: true, found, context: getPageContext("manual-scan") });
    return undefined;
});
