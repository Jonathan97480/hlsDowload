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

function normalizeUrl(url) {
    return typeof url === "string" ? url.trim() : "";
}

function isSupportedMediaUrl(url) {
    return /^https?:\/\//i.test(url) && /\.(m3u8|mp4)(\?.*)?$/i.test(url);
}

function normalizeEntry(entry) {
    if (typeof entry === "string") return { url: entry, context: {} };
    if (entry && typeof entry === "object" && typeof entry.url === "string") {
        return { url: entry.url, context: entry.context || {} };
    }
    return null;
}

function scoreCandidate(url) {
    try {
        const lower = new URL(url).pathname.toLowerCase();
        let score = 0;
        if (/master\.m3u8|manifest\.m3u8|playlist\.m3u8|main\.m3u8|stream\.m3u8/.test(lower)) score += 120;
        if (/index\.m3u8/.test(lower)) score += 80;
        if (/\.mp4$/.test(lower)) score += 50;
        if (/index-v\d+-a\d+|segment-\d+|variant[_-]\d+|quality[_-](360|480|720|1080)/.test(lower)) score -= 90;
        return score - (lower.length * 0.01);
    } catch (_error) {
        return -9999;
    }
}

function getBestEntry(urls) {
    let best = null;
    let bestScore = -Infinity;
    (Array.isArray(urls) ? urls : []).forEach((item) => {
        const normalized = normalizeEntry(item);
        if (!normalized || !isSupportedMediaUrl(normalized.url)) return;
        const score = scoreCandidate(normalized.url);
        if (score > bestScore) {
            bestScore = score;
            best = normalized;
        }
    });
    return best;
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
    try {
        const response = await fetch(`${serverUrl}/capacity`, {
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
        return;
    }

    try {
        await chrome.downloads.download({
            url: `${job.serverOrigin}${job.filePath}`,
            filename: job.fileName,
            saveAs: false
        });
    } catch (_error) {
        // Silent failure: final state remains completed.
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
                jobId: data.jobId,
                fileName: data.fileName || item.body?.fileName || "",
                filePath: data.filePath || "",
                status: data.status || "queued",
                progress: data.status === "completed" ? 100 : 0,
                timemark: "",
                message: data.message || "Job demarre",
                error: ""
            };

            if (job.status === "completed") {
                await downloadCompletedFile(job);
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
                    error: data.error || ""
                };

                if (nextJob.status === "completed") {
                    await downloadCompletedFile(nextJob);
                    state.recentJobs.unshift(nextJob);
                } else if (nextJob.status === "failed") {
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
    const sources = [mediaUrl, pageUrl].filter((u) => typeof u === "string" && u.startsWith("http"));
    const allCookies = new Map();

    for (const url of sources) {
        try {
            const raw = await fetchCookiesForUrl(url);
            if (!raw) continue;
            raw.split("; ").forEach((pair) => {
                const eq = pair.indexOf("=");
                if (eq > 0) {
                    allCookies.set(pair.slice(0, eq), pair);
                }
            });
        } catch (_error) { /* skip */ }
    }

    return allCookies.size > 0 ? Array.from(allCookies.values()).join("; ") : "";
}

function rememberUrl(tabId, url, context = {}) {
    const safeUrl = normalizeUrl(url);
    if (!isSupportedMediaUrl(safeUrl) || tabId < 0) return;

    const urls = tabStreams.get(tabId) || [];
    const exists = urls.some((item) => normalizeEntry(item)?.url === safeUrl);
    if (exists) return;

    const entry = { url: safeUrl, context: context || {} };
    urls.unshift(entry);
    tabStreams.set(tabId, urls.slice(0, 20));

    const pageUrl = context.referer || context.documentUrl || "";
    fetchCookiesForMediaAndPage(safeUrl, pageUrl).then((cookieStr) => {
        entry.context.cookie = cookieStr;

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
    (details) => rememberUrl(details.tabId, details.url, { referer: details.initiator || details.url }),
    { urls: ["<all_urls>"] }
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "captureUrl") {
        rememberUrl(sender.tab?.id ?? -1, message.url, message.context || {});
        sendResponse({ ok: true });
        return;
    }

    if (message?.type === "getLatestUrl") {
        const tabId = Number(message.tabId);
        const urls = tabStreams.get(tabId) || [];
        const best = getBestEntry(urls);
        const all = urls.map((item) => normalizeEntry(item)).filter((item) => item && item.url);
        sendResponse({ ok: true, latest: best || all[0] || "", all });
        return;
    }

    if (message?.type === "addToQueue") {
        const item = message.item || {};
        const serverUrl = String(item.serverUrl || "").trim();
        const apiKey = String(item.apiKey || "").trim();
        const body = item.body || {};

        if (!serverUrl || !apiKey || !body?.url) {
            sendResponse({ ok: false, error: "Parametres manquants" });
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

        return true;
    }

    if (message?.type === "getQueue") {
        getManagerState()
            .then((state) => sendResponse({ ok: true, queue: state.queue }))
            .catch(() => sendResponse({ ok: true, queue: [] }));
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
                        error: firstActive?.error || latestRecent?.error || ""
                    }
                });
            })
            .catch(() => sendResponse({ ok: true, state: defaultManagerState() }));

        return true;
    }

    return undefined;
});
