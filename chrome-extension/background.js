const tabStreams = new Map();
const STREAMS_KEY = "tabStreams";
const MANAGER_KEY = "downloadManagerState";
const POLL_ALARM = "download-manager-poll";
const PUBLIC_IP_CACHE_TTL_MS = 10 * 60 * 1000;

let publicIpCache = {
    value: "",
    expiresAt: 0
};

let managerLock = Promise.resolve();

function getHeaderValue(requestHeaders, headerName) {
    const match = (Array.isArray(requestHeaders) ? requestHeaders : []).find((header) =>
        String(header?.name || "").toLowerCase() === String(headerName || "").toLowerCase()
    );
    return typeof match?.value === "string" ? match.value.trim() : "";
}

function normalizeUrl(url) {
    return typeof url === "string" ? url.trim() : "";
}

function getMediaCandidateKind(url) {
    const normalized = normalizeUrl(url);

    if (!/^https?:\/\//i.test(normalized)) {
        return "";
    }

    try {
        const parsed = new URL(normalized);
        const pathname = parsed.pathname.toLowerCase();
        const search = `${parsed.search}${parsed.hash}`.toLowerCase();
        const combined = `${pathname}${search}`;

        if (/\.m3u8(?:$|[?#])/i.test(normalized)) {
            return "hls_exact";
        }

        if (/\.mp4(?:$|[?#])/i.test(normalized)) {
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

function normalizeEntry(entry) {
    if (typeof entry === "string") return { url: entry, context: {} };
    if (entry && typeof entry === "object" && typeof entry.url === "string") {
        return { url: entry.url, context: entry.context || {} };
    }
    return null;
}

function isNetworkContext(context = {}) {
    const source = String(context?.source || "").trim().toLowerCase();
    return source === "network-request" ||
        source === "network-headers" ||
        source === "fetch" ||
        source === "xhr" ||
        source === "page-hook";
}

function scoreCandidate(entry) {
    try {
        const url = typeof entry === "string" ? entry : entry?.url;
        const context = typeof entry === "object" && entry ? (entry.context || {}) : {};
        const parsed = new URL(url);
        const lower = `${parsed.pathname}${parsed.search}`.toLowerCase();
        const kind = getMediaCandidateKind(url);
        let score = 0;

        if (kind === "hls_exact") score += 160;
        if (kind === "mp4_exact") score += 120;
        if (kind === "hls_hint") score += 70;
        if (kind === "mp4_hint") score += 55;
        if (/master\.m3u8|manifest\.m3u8|playlist\.m3u8|main\.m3u8|stream\.m3u8/.test(lower)) score += 120;
        if (/index\.m3u8/.test(lower)) score += 80;
        if (/\.mp4(?:$|[?#])/.test(lower)) score += 50;
        if (/index-v\d+-a\d+|segment-\d+|variant[_-]\d+|quality[_-](360|480|720|1080)|seg-\d+/.test(lower)) score -= 90;
        if (isNetworkContext(context)) score += 500;
        return score - (lower.length * 0.01);
    } catch (_error) {
        return -9999;
    }
}

function getBestEntry(urls, options = {}) {
    const networkOnly = options.networkOnly === true;
    let best = null;
    let bestScore = -Infinity;
    (Array.isArray(urls) ? urls : []).forEach((item) => {
        const normalized = normalizeEntry(item);
        if (!normalized || !isSupportedMediaUrl(normalized.url)) return;
        if (networkOnly && !isNetworkContext(normalized.context)) return;
        const score = scoreCandidate(normalized);
        if (score > bestScore) {
            bestScore = score;
            best = normalized;
        }
    });
    return best;
}

function getExactEntryForTab(tabId, targetUrl) {
    const normalizedTarget = normalizeUrl(targetUrl);
    const urls = tabStreams.get(Number(tabId)) || [];
    return urls
        .map((item) => normalizeEntry(item))
        .find((item) => item && normalizeUrl(item.url) === normalizedTarget) || null;
}

function getBestNetworkEntryForTab(tabId) {
    const urls = tabStreams.get(Number(tabId)) || [];
    return getBestEntry(urls, { networkOnly: true });
}

function deriveOriginFromContext(context = {}) {
    const candidates = [context.origin, context.documentUrl, context.referer];
    for (const value of candidates) {
        try {
            if (!value) continue;
            return new URL(value).origin;
        } catch (_error) { }
    }
    return "";
}

function countCookiePairs(cookieValue) {
    const raw = String(cookieValue || "").trim();
    if (!raw) {
        return 0;
    }

    return raw.split(";").map((part) => part.trim()).filter(Boolean).length;
}

async function fetchCookieDebugForMediaAndPage(mediaUrl, pageUrl) {
    const safeMediaUrl = typeof mediaUrl === "string" && mediaUrl.startsWith("http") ? mediaUrl : "";
    const safePageUrl = typeof pageUrl === "string" && pageUrl.startsWith("http") ? pageUrl : "";
    let mediaCookie = "";
    let pageCookie = "";

    if (safeMediaUrl) {
        try {
            mediaCookie = await fetchCookiesForUrl(safeMediaUrl);
        } catch (_error) { }
    }

    if (safePageUrl) {
        try {
            pageCookie = await fetchCookiesForUrl(safePageUrl);
        } catch (_error) { }
    }

    return {
        mediaCookie,
        mediaCookieCount: countCookiePairs(mediaCookie),
        pageCookie,
        pageCookieCount: countCookiePairs(pageCookie)
    };
}

async function enrichDirectMediaItem(item = {}) {
    const body = item.body && typeof item.body === "object" ? { ...item.body } : {};
    const tabId = Number.isInteger(item.tabId) ? item.tabId : -1;
    const requestedUrl = normalizeUrl(body.url);
    const exactEntry = tabId >= 0 ? getExactEntryForTab(tabId, requestedUrl) : null;
    const networkFallbackEntry = !exactEntry && tabId >= 0 ? getBestNetworkEntryForTab(tabId) : null;
    const selectedEntry = exactEntry || networkFallbackEntry;
    const effectiveUrl = normalizeUrl(selectedEntry?.url || requestedUrl);
    const entryContext = selectedEntry?.context || {};
    const detectedContext = item.detectedContext && typeof item.detectedContext === "object" ? item.detectedContext : {};
    const mergedContext = {
        ...detectedContext,
        ...entryContext
    };
    const referer = String(body.headers?.referer || mergedContext.referer || "").trim();
    const userAgent = String(body.headers?.userAgent || mergedContext.userAgent || "").trim();
    const documentUrl = String(mergedContext.documentUrl || referer || "").trim();
    const cookieDebug = await fetchCookieDebugForMediaAndPage(effectiveUrl, documentUrl);
    const cookie = String(
        body.headers?.cookie ||
        mergedContext.cookie ||
        cookieDebug.mediaCookie ||
        cookieDebug.pageCookie
    ).trim();
    const origin = String(body.headers?.origin || mergedContext.origin || deriveOriginFromContext(mergedContext)).trim();

    return {
        ...item,
        body: {
            ...body,
            url: effectiveUrl,
            headers: {
                ...(body.headers || {}),
                referer,
                userAgent,
                cookie,
                origin
            },
            debug: {
                exactEntryFound: Boolean(exactEntry),
                networkFallbackUsed: Boolean(!exactEntry && networkFallbackEntry),
                detectedContextKeys: Object.keys(detectedContext),
                mergedContextKeys: Object.keys(mergedContext),
                mediaCookieCount: cookieDebug.mediaCookieCount,
                pageCookieCount: cookieDebug.pageCookieCount,
                finalCookieCount: countCookiePairs(cookie),
                originDerived: origin,
                documentUrl,
                requestedUrl,
                effectiveUrl,
                selectedSource: String(selectedEntry?.context?.source || "")
            }
        }
    };
}

function defaultManagerState() {
    return {
        queue: [],
        activeJobs: [],
        recentJobs: [],
        maxConcurrent: 1,
        updatedAt: Date.now()
    };
}

async function getManagerState() {
    const stored = await chrome.storage.local.get(MANAGER_KEY);
    return { ...defaultManagerState(), ...(stored?.[MANAGER_KEY] || {}) };
}

async function saveManagerState(state) {
    const next = {
        ...defaultManagerState(),
        ...(state || {}),
        queue: Array.isArray(state?.queue) ? state.queue : [],
        activeJobs: Array.isArray(state?.activeJobs) ? state.activeJobs : [],
        recentJobs: Array.isArray(state?.recentJobs) ? state.recentJobs.slice(0, 30) : [],
        updatedAt: Date.now()
    };

    await chrome.storage.local.set({ [MANAGER_KEY]: next });
    return next;
}

function withManagerLock(task) {
    managerLock = managerLock.then(task, task);
    return managerLock;
}

function originFromServerUrl(serverUrl) {
    try {
        return new URL(serverUrl).origin;
    } catch (_error) {
        return "http://localhost:3000";
    }
}

function normalizeIp(ip) {
    const value = String(ip || "").trim().replace(/^::ffff:/i, "");
    return value;
}

function isPublicIp(ip) {
    const value = normalizeIp(ip);

    if (!value) {
        return false;
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(value)) {
            return false;
        }

        return true;
    }

    if (/^[0-9a-f:]+$/i.test(value)) {
        const lower = value.toLowerCase();
        if (lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")) {
            return false;
        }

        return true;
    }

    return false;
}

async function fetchPublicIpFrom(url, mapper) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    try {
        const response = await fetch(url, {
            method: "GET",
            signal: controller.signal,
            cache: "no-store"
        });

        if (!response.ok) {
            return "";
        }

        const value = await mapper(response);
        const normalized = normalizeIp(value);
        return isPublicIp(normalized) ? normalized : "";
    } catch (_error) {
        return "";
    } finally {
        clearTimeout(timeoutId);
    }
}

async function resolvePublicIp() {
    if (publicIpCache.value && publicIpCache.expiresAt > Date.now()) {
        return publicIpCache.value;
    }

    const providers = [
        () => fetchPublicIpFrom("https://api.ipify.org?format=json", async (res) => (await res.json())?.ip || ""),
        () => fetchPublicIpFrom("https://api64.ipify.org?format=json", async (res) => (await res.json())?.ip || ""),
        () => fetchPublicIpFrom("https://ifconfig.me/ip", async (res) => await res.text())
    ];

    for (const provider of providers) {
        const ip = await provider();
        if (ip) {
            publicIpCache = {
                value: ip,
                expiresAt: Date.now() + PUBLIC_IP_CACHE_TTL_MS
            };
            return ip;
        }
    }

    return "";
}

async function fetchCapacity(serverUrl, apiKey) {
    const rawUrl = String(serverUrl || "").trim();
    let capacityUrl = `${rawUrl}/capacity`;

    if (/\/api\/download\/youtube$/i.test(rawUrl)) {
        capacityUrl = rawUrl.replace(/\/api\/download\/youtube$/i, "/api/download/capacity");
    } else if (/\/api\/download$/i.test(rawUrl)) {
        capacityUrl = `${rawUrl}/capacity`;
    } else if (/\/api$/i.test(rawUrl)) {
        capacityUrl = `${rawUrl}/download/capacity`;
    }

    try {
        const response = await fetch(capacityUrl, {
            method: "GET",
            headers: { "x-api-key": apiKey }
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error || "Erreur capacite");
        }

        const max = Number.parseInt(data.maxConcurrentDownloads, 10);
        return Number.isFinite(max) && max > 0 ? Math.min(12, max) : 1;
    } catch (_error) {
        return 1;
    }
}

async function downloadCompletedFile(job) {
    if (!job.filePath || !job.fileName || !job.serverOrigin) {
        return { ok: false, error: "Chemin de telechargement incomplet" };
    }

    try {
        const downloadUrl = new URL(job.filePath, job.serverOrigin).toString();
        const probe = await fetch(downloadUrl, {
            method: "GET",
            headers: { Range: "bytes=0-0" }
        });
        const contentType = String(probe.headers.get("content-type") || "").toLowerCase();

        if (!probe.ok) {
            return {
                ok: false,
                error: `Fichier indisponible (${probe.status})`
            };
        }

        if (contentType.includes("application/json")) {
            return {
                ok: false,
                error: "Le serveur a renvoye du JSON au lieu de la video"
            };
        }

        await chrome.downloads.download({
            url: downloadUrl,
            filename: job.fileName,
            saveAs: false
        });
        return { ok: true };
    } catch (_error) {
        return {
            ok: false,
            error: _error && _error.message ? _error.message : "Echec du telechargement navigateur"
        };
    }
}

function schedulePoll(delayMs = 1800) {
    chrome.alarms.create(POLL_ALARM, { when: Date.now() + delayMs });
}

async function startQueuedJobsInternal(state) {
    while (state.queue.length > 0) {
        const probe = state.queue[0];
        const capacity = await fetchCapacity(probe.serverUrl, probe.apiKey);
        state.maxConcurrent = capacity;

        if (state.activeJobs.length >= capacity) {
            break;
        }

        const item = state.queue.shift();
        const serverOrigin = originFromServerUrl(item.serverUrl);
        const clientPublicIp = await resolvePublicIp();
        const payload = {
            ...(item.body || {}),
            clientPublicIp
        };
        const requestHeaders = {
            "Content-Type": "application/json",
            "x-api-key": item.apiKey
        };

        if (clientPublicIp) {
            requestHeaders["x-client-public-ip"] = clientPublicIp;
        }

        try {
            const response = await fetch(`${item.serverUrl}/start`, {
                method: "POST",
                headers: requestHeaders,
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (!response.ok || !data?.jobId) {
                throw new Error(data?.error || data?.message || "Echec demarrage job");
            }

            const job = {
                id: item.id,
                createdAt: item.createdAt,
                updatedAt: Date.now(),
                serverUrl: item.serverUrl,
                serverOrigin,
                apiKey: item.apiKey,
                youtubeVideoId: item.youtubeVideoId || item.body?.videoId || "",
                jobId: data.jobId,
                fileName: data.fileName || item.body?.fileName || "",
                filePath: data.filePath || "",
                sourceIp: data.sourceIp || "",
                status: data.status || "queued",
                progress: data.status === "completed" ? 100 : 0,
                timemark: "",
                message: data.message || "Job demarre",
                error: ""
            };

            if (job.status === "completed") {
                const downloadResult = await downloadCompletedFile(job);
                if (!downloadResult.ok) {
                    job.message = "Telechargement termine, envoi navigateur echoue";
                    job.error = downloadResult.error || "";
                }
                state.recentJobs.unshift(job);
            } else {
                state.activeJobs.push(job);
            }
        } catch (error) {
            state.recentJobs.unshift({
                id: item.id,
                createdAt: item.createdAt,
                updatedAt: Date.now(),
                status: "failed",
                progress: 0,
                fileName: item.body?.fileName || "",
                filePath: "",
                message: "Echec demarrage",
                error: error.message || "Erreur reseau"
            });
        }
    }

    state.recentJobs = state.recentJobs.slice(0, 30);
    return state;
}

async function startQueuedJobs() {
    await withManagerLock(async () => {
        const state = await getManagerState();
        await startQueuedJobsInternal(state);
        await saveManagerState(state);

        if (state.activeJobs.length > 0) {
            schedulePoll(1200);
        }
    });
}

async function pollActiveJobs() {
    await withManagerLock(async () => {
        const state = await getManagerState();

        if (state.activeJobs.length === 0) {
            await startQueuedJobsInternal(state);
            await saveManagerState(state);
            return;
        }

        const nextActive = [];

        for (const job of state.activeJobs) {
            try {
                const response = await fetch(`${job.serverUrl}/status/${job.jobId}`, {
                    method: "GET",
                    headers: { "x-api-key": job.apiKey }
                });

                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data?.error || "Erreur statut");
                }

                const nextJob = {
                    ...job,
                    updatedAt: Date.now(),
                    status: data.status || "running",
                    progress: Number.isFinite(data.progress) ? data.progress : 0,
                    timemark: data.timemark || "",
                    message: data.message || "",
                    fileName: data.fileName || job.fileName || "",
                    filePath: data.filePath || job.filePath || "",
                    sourceIp: data.sourceIp || job.sourceIp || "",
                    error: data.error || ""
                };

                if (nextJob.status === "completed") {
                    const downloadResult = await downloadCompletedFile(nextJob);
                    if (!downloadResult.ok) {
                        nextJob.message = "Telechargement termine, envoi navigateur echoue";
                        nextJob.error = downloadResult.error || "";
                    }
                    state.recentJobs.unshift(nextJob);
                } else if (nextJob.status === "failed" || nextJob.status === "cancelled") {
                    state.recentJobs.unshift(nextJob);
                } else {
                    nextActive.push(nextJob);
                }
            } catch (error) {
                nextActive.push({
                    ...job,
                    updatedAt: Date.now(),
                    message: "Polling en attente...",
                    error: error.message || "Erreur reseau"
                });
            }
        }

        state.activeJobs = nextActive;
        state.recentJobs = state.recentJobs.slice(0, 30);
        await startQueuedJobsInternal(state);
        await saveManagerState(state);

        if (state.activeJobs.length > 0) {
            schedulePoll(2000);
        }
    });
}

function fetchCookiesForUrl(url) {
    return new Promise((resolve) => {
        chrome.cookies.getAll({ url }, (cookies) => {
            if (!Array.isArray(cookies) || cookies.length === 0) {
                resolve("");
                return;
            }
            resolve(cookies.map((c) => `${c.name}=${c.value}`).join("; "));
        });
    });
}

async function fetchCookiesForMediaAndPage(mediaUrl, pageUrl) {
    // Keep cookies scoped to the media host first. Mixing unrelated domains can trigger 403.
    const safeMediaUrl = typeof mediaUrl === "string" && mediaUrl.startsWith("http") ? mediaUrl : "";
    const safePageUrl = typeof pageUrl === "string" && pageUrl.startsWith("http") ? pageUrl : "";

    if (safeMediaUrl) {
        try {
            const mediaCookies = await fetchCookiesForUrl(safeMediaUrl);
            if (mediaCookies) {
                return mediaCookies;
            }
        } catch (_error) { /* skip */ }
    }

    if (safePageUrl) {
        try {
            return await fetchCookiesForUrl(safePageUrl);
        } catch (_error) { /* skip */ }
    }

    return "";
}

function rememberUrl(tabId, url, context = {}) {
    const safeUrl = normalizeUrl(url);
    if (!isSupportedMediaUrl(safeUrl) || tabId < 0) return;

    const urls = tabStreams.get(tabId) || [];
    const existingEntry = urls.find((item) => normalizeEntry(item)?.url === safeUrl);
    const entry = existingEntry || { url: safeUrl, context: {} };
    entry.context = {
        ...(entry.context || {}),
        ...(context || {})
    };

    if (!existingEntry) {
        urls.unshift(entry);
    }

    tabStreams.set(tabId, urls.slice(0, 20));

    const pageUrl = context.referer || context.documentUrl || "";
    fetchCookiesForMediaAndPage(safeUrl, pageUrl).then((cookieStr) => {
        if (cookieStr || !entry.context.cookie) {
            entry.context.cookie = cookieStr;
        }

        const out = {};
        for (const [id, values] of tabStreams.entries()) {
            out[String(id)] = values;
        }
        chrome.storage.local.set({ [STREAMS_KEY]: out }).catch(() => { });
    });
}

async function hydrateFromStorage() {
    const stored = await chrome.storage.local.get(STREAMS_KEY);
    const raw = stored?.[STREAMS_KEY] || {};

    Object.keys(raw).forEach((key) => {
        const tabId = Number(key);
        const urls = Array.isArray(raw[key]) ? raw[key] : [];
        if (Number.isInteger(tabId) && tabId >= 0 && urls.length > 0) {
            tabStreams.set(tabId, urls.slice(0, 20));
        }
    });
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => rememberUrl(details.tabId, details.url, {
        referer: details.initiator || details.url,
        documentUrl: details.documentUrl || "",
        source: "network-request"
    }),
    { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        if (!isSupportedMediaUrl(details.url)) {
            return;
        }

        rememberUrl(details.tabId, details.url, {
            referer: getHeaderValue(details.requestHeaders, "referer") || details.initiator || details.url,
            origin: getHeaderValue(details.requestHeaders, "origin"),
            userAgent: getHeaderValue(details.requestHeaders, "user-agent"),
            cookie: getHeaderValue(details.requestHeaders, "cookie"),
            documentUrl: details.documentUrl || "",
            source: "network-headers"
        });
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
    tabStreams.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
        tabStreams.delete(tabId);
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === POLL_ALARM) {
        pollActiveJobs().catch(() => { });
    }
});

hydrateFromStorage().catch(() => { });

const YOUTUBE_KEY = "youtubeVideoCache";

async function getYoutubeCache() {
    const stored = await chrome.storage.local.get(YOUTUBE_KEY);
    return stored?.[YOUTUBE_KEY] || { videoId: "", videoTitle: "", url: "" };
}

async function saveYoutubeCache(data) {
    await chrome.storage.local.set({ [YOUTUBE_KEY]: data });
}

function buildYoutubeServerUrl(serverUrl) {
    const base = String(serverUrl || "").trim().replace(/\/$/, "");
    if (!base) return "";
    if (/\/api\/download\/?$/.test(base)) return base.replace(/\/api\/download\/?$/, "/api/download/youtube");
    if (/\/api\/?$/.test(base)) return `${base}/download/youtube`;
    return `${base}/api/download/youtube`;
}

function buildYoutubePlaylistServerUrl(serverUrl) {
    const youtubeBase = buildYoutubeServerUrl(serverUrl);
    return youtubeBase ? `${youtubeBase}/playlist` : "";
}

function buildControlServerUrl(serverUrl) {
    const base = String(serverUrl || "").trim().replace(/\/$/, "");
    if (!base) return "";
    if (/\/api\/download\/youtube$/i.test(base)) return base.replace(/\/api\/download\/youtube$/i, "/api/download/control");
    if (/\/api\/download$/i.test(base)) return `${base}/control`;
    if (/\/api\/?$/.test(base)) return `${base}/download/control`;
    return `${base}/api/download/control`;
}

function hasQueuedYouTubeVideo(state, videoId) {
    const target = String(videoId || "").trim();
    if (!target) return false;

    const inQueue = (state.queue || []).some((item) => String(item.youtubeVideoId || item.body?.videoId || "").trim() === target);
    const inActive = (state.activeJobs || []).some((job) => String(job.youtubeVideoId || job.videoId || "").trim() === target);
    const inRecent = (state.recentJobs || []).some((job) => String(job.youtubeVideoId || job.videoId || "").trim() === target);
    return inQueue || inActive || inRecent;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "youtubeDetected") {
        const data = {
            videoId: message.videoId || "",
            videoTitle: message.videoTitle || "",
            url: message.url || "",
            context: message.context || {}
        };
        saveYoutubeCache(data);
        sendResponse({ ok: true });
        return;
    }

    if (message?.type === "getYoutubeVideo") {
        getYoutubeCache().then((data) => sendResponse({ ok: true, video: data })).catch(() => sendResponse({ ok: false }));
        return true;
    }

    if (message?.type === "addYoutubeToQueue") {
        const item = message.item || {};
        const serverUrl = String(item.serverUrl || "").trim();
        const apiKey = String(item.apiKey || "").trim();
        const videoId = String(item.videoId || "").trim();
        const videoTitle = String(item.videoTitle || "").trim();

        if (!serverUrl || !apiKey || !videoId) {
            sendResponse({ ok: false, error: "videoId, serverUrl et apiKey requis" });
            return;
        }

        const youtubeServerUrl = buildYoutubeServerUrl(serverUrl);

        withManagerLock(async () => {
            const state = await getManagerState();
            state.queue.push({
                id: crypto.randomUUID(),
                createdAt: Date.now(),
                serverUrl: youtubeServerUrl,
                apiKey,
                youtubeVideoId: videoId,
                body: {
                    videoId,
                    fileName: videoTitle,
                    headers: item.headers || {}
                }
            });
            await startQueuedJobsInternal(state);
            await saveManagerState(state);
            if (state.activeJobs.length > 0) {
                schedulePoll(1000);
            }
            sendResponse({ ok: true, queue: state.queue, state });
        }).catch((error) => sendResponse({ ok: false, error: error.message || "Erreur file YouTube" }));

        return true;
    }

    if (message?.type === "addYoutubePlaylistToQueue") {
        const item = message.item || {};
        const serverUrl = String(item.serverUrl || "").trim();
        const apiKey = String(item.apiKey || "").trim();
        const playlistUrl = String(item.playlistUrl || "").trim();

        if (!serverUrl || !apiKey || !playlistUrl) {
            sendResponse({ ok: false, error: "playlistUrl, serverUrl et apiKey requis" });
            return;
        }

        const playlistServerUrl = buildYoutubePlaylistServerUrl(serverUrl);
        const youtubeServerUrl = buildYoutubeServerUrl(serverUrl);

        withManagerLock(async () => {
            const playlistResponse = await fetch(playlistServerUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey
                },
                body: JSON.stringify({
                    playlistUrl,
                    headers: item.headers || {}
                })
            });

            const playlistData = await playlistResponse.json();
            if (!playlistResponse.ok) {
                throw new Error(playlistData?.error || "Echec analyse playlist");
            }

            const state = await getManagerState();
            let addedCount = 0;
            let skippedCount = 0;

            (Array.isArray(playlistData.videos) ? playlistData.videos : []).forEach((video) => {
                const videoId = String(video.videoId || "").trim();
                if (!videoId || hasQueuedYouTubeVideo(state, videoId)) {
                    skippedCount += 1;
                    return;
                }

                state.queue.push({
                    id: crypto.randomUUID(),
                    createdAt: Date.now(),
                    serverUrl: youtubeServerUrl,
                    apiKey,
                    youtubeVideoId: videoId,
                    body: {
                        videoId,
                        fileName: String(video.title || "").trim(),
                        headers: {
                            ...(item.headers || {}),
                            referer: String(video.url || playlistUrl).trim() || playlistUrl
                        }
                    }
                });
                addedCount += 1;
            });

            await startQueuedJobsInternal(state);
            await saveManagerState(state);
            if (state.activeJobs.length > 0) {
                schedulePoll(1000);
            }

            sendResponse({
                ok: true,
                queue: state.queue,
                state,
                playlistTitle: playlistData.playlistTitle || "",
                addedCount,
                skippedCount
            });
        }).catch((error) => sendResponse({ ok: false, error: error.message || "Erreur playlist YouTube" }));

        return true;
    }

    if (message?.type === "captureUrl") {
        rememberUrl(sender.tab?.id ?? -1, message.url, message.context || {});
        sendResponse({ ok: true });
        return;
    }

    if (message?.type === "getLatestUrl") {
        const tabId = Number(message.tabId);
        const urls = tabStreams.get(tabId) || [];
        const best = getBestEntry(urls, { networkOnly: true }) || getBestEntry(urls);
        const all = urls.map((item) => normalizeEntry(item)).filter((item) => item && item.url);
        sendResponse({ ok: true, latest: best || all[0] || "", all });
        return;
    }

    if (message?.type === "addToQueue") {
        const rawItem = message.item || {};

        enrichDirectMediaItem(rawItem).then((item) => {
            const serverUrl = String(item.serverUrl || "").trim();
            const apiKey = String(item.apiKey || "").trim();
            const body = item.body || {};
            const debug = body.debug || {};

            if (!serverUrl || !apiKey || !body?.url) {
                sendResponse({ ok: false, error: "Parametres manquants" });
                return;
            }

            if (!debug.exactEntryFound && !debug.networkFallbackUsed) {
                sendResponse({ ok: false, error: "Aucune requete media reseau correspondante detectee pour cet onglet. Reclique sur Detecter apres lecture de la video." });
                return;
            }

            withManagerLock(async () => {
                const state = await getManagerState();
                state.queue.push({
                    id: crypto.randomUUID(),
                    createdAt: Date.now(),
                    serverUrl,
                    apiKey,
                    body
                });
                await startQueuedJobsInternal(state);
                await saveManagerState(state);
                if (state.activeJobs.length > 0) {
                    schedulePoll(1000);
                }
                sendResponse({ ok: true, queue: state.queue, state });
            }).catch((error) => sendResponse({ ok: false, error: error.message || "Erreur file" }));
        }).catch((error) => sendResponse({ ok: false, error: error.message || "Erreur enrichissement file" }));

        return true;
    }

    if (message?.type === "getQueue") {
        getManagerState()
            .then((state) => sendResponse({ ok: true, queue: state.queue }))
            .catch(() => sendResponse({ ok: true, queue: [] }));
        return true;
    }

    if (message?.type === "stopCurrentDownload") {
        withManagerLock(async () => {
            const state = await getManagerState();
            const targetJob = state.activeJobs[0] || null;

            if (!targetJob?.jobId || !targetJob?.serverUrl) {
                sendResponse({ ok: false, error: "Aucun telechargement actif a arreter" });
                return;
            }

            const controlUrl = `${buildControlServerUrl(targetJob.serverUrl)}/stop/${targetJob.jobId}`;
            const response = await fetch(controlUrl, {
                method: "POST",
                headers: { "x-api-key": targetJob.apiKey }
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data?.error || "Arret impossible");
            }

            state.activeJobs = state.activeJobs.filter((job) => job.jobId !== targetJob.jobId);
            state.recentJobs.unshift({
                ...targetJob,
                status: "cancelled",
                message: data?.message || "Arret demande",
                error: ""
            });
            await saveManagerState(state);
            sendResponse({ ok: true, state });
        }).catch((error) => sendResponse({ ok: false, error: error.message || "Erreur arret" }));
        return true;
    }

    if (message?.type === "clearPendingQueue") {
        withManagerLock(async () => {
            const state = await getManagerState();
            const clearedCount = Array.isArray(state.queue) ? state.queue.length : 0;
            const queuedServerJobs = (state.activeJobs || []).filter((job) => job.status === "queued" && job.jobId && job.serverUrl);

            for (const job of queuedServerJobs) {
                const controlUrl = `${buildControlServerUrl(job.serverUrl)}/stop/${job.jobId}`;
                try {
                    await fetch(controlUrl, {
                        method: "POST",
                        headers: { "x-api-key": job.apiKey }
                    });
                } catch (_error) { }
            }

            state.queue = [];
            state.activeJobs = (state.activeJobs || []).filter((job) => job.status !== "queued");
            state.recentJobs = [
                ...(queuedServerJobs.map((job) => ({
                    ...job,
                    status: "cancelled",
                    message: "Retire de la file d'attente",
                    error: "Annule par utilisateur",
                    updatedAt: Date.now()
                }))),
                ...(state.recentJobs || [])
            ].slice(0, 30);
            await saveManagerState(state);
            sendResponse({ ok: true, clearedCount: clearedCount + queuedServerJobs.length, state });
        }).catch((error) => sendResponse({ ok: false, error: error.message || "Erreur file" }));
        return true;
    }

    if (message?.type === "getDownloadState") {
        getManagerState()
            .then((state) => {
                const firstActive = state.activeJobs[0] || null;
                const latestRecent = state.recentJobs[0] || null;

                sendResponse({
                    ok: true,
                    state: {
                        maxConcurrent: state.maxConcurrent,
                        queue: state.queue,
                        activeJobs: state.activeJobs,
                        recentJobs: state.recentJobs,
                        status: firstActive?.status || latestRecent?.status || "idle",
                        progress: firstActive?.progress || 0,
                        timemark: firstActive?.timemark || "",
                        message: firstActive?.message || latestRecent?.message || "",
                        fileName: firstActive?.fileName || latestRecent?.fileName || "",
                        filePath: firstActive?.filePath || latestRecent?.filePath || "",
                        sourceIp: firstActive?.sourceIp || latestRecent?.sourceIp || "",
                        error: firstActive?.error || latestRecent?.error || ""
                    }
                });
            })
            .catch(() => sendResponse({ ok: true, state: defaultManagerState() }));

        return true;
    }

    return undefined;
});
