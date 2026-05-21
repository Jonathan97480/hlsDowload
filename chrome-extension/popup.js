const serverUrlInput = document.getElementById("serverUrl");
const apiKeyInput = document.getElementById("apiKey");
const mediaUrlInput = document.getElementById("mediaUrl");
const videoNameInput = document.getElementById("videoName");
const refererInput = document.getElementById("referer");
const userAgentInput = document.getElementById("userAgent");
const cookieInput = document.getElementById("cookie");
const detectBtn = document.getElementById("detectBtn");
const sendBtn = document.getElementById("sendBtn");
const youtubeBtn = document.getElementById("youtubeBtn");
const playlistBtn = document.getElementById("playlistBtn");
const playlistSection = document.getElementById("playlistSection");
const playlistUrlInput = document.getElementById("playlistUrl");
const playlistQueueBtn = document.getElementById("playlistQueueBtn");
const stopBtn = document.getElementById("stopBtn");
const clearQueueBtn = document.getElementById("clearQueueBtn");
const recentToggleBtn = document.getElementById("recentToggleBtn");
const recentBody = document.getElementById("recentBody");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const result = document.getElementById("result");
const mediaUrlSection = document.getElementById("mediaUrlSection");
const activeSection = document.getElementById("activeSection");
const queueSection = document.getElementById("queueSection");
const youtubeSection = document.getElementById("youtubeSection");
const youtubeVideoIdEl = document.getElementById("youtubeVideoId");
const youtubeVideoTitleEl = document.getElementById("youtubeVideoTitle");

const DEFAULT_SERVER_URL = "http://localhost:3000/api/download";
const DEFAULT_API_KEY = "125456Aprt";
let activePoller = null;
let recentExpanded = false;
let currentDetectedContext = {};
stopBtn.disabled = true;
clearQueueBtn.disabled = true;

function updateActionButtons(isYouTubePage) {
    if (isYouTubePage) {
        hideSection(sendBtn);
        showSection(youtubeBtn, "block");
        showSection(playlistBtn, "block");
        return;
    }

    showSection(sendBtn, "block");
    hideSection(youtubeBtn);
    hideSection(playlistBtn);
    hideSection(playlistSection);
}

function buildServerOrigin(serverUrl) {
    try {
        return new URL(serverUrl).origin;
    } catch (_error) {
        return "http://localhost:3000";
    }
}

function normalizeVideoName(rawValue) {
    if (typeof rawValue !== "string") {
        return "";
    }

    return rawValue.replace(/\s+/g, " ").trim().slice(0, 500);
}

function setResult(payload) {
    // Show plain string messages to the user; keep JSON internal only.
    const statusMsg = document.getElementById("statusMsg");
    if (typeof payload === "string") {
        if (statusMsg) statusMsg.textContent = payload;
    } else {
        // Keep internal JSON hidden; show a friendly status if available.
        const friendly = payload?.message || payload?.status || "";
        if (statusMsg && friendly) statusMsg.textContent = friendly;
    }
    // Internal log for debugging (element is hidden).
    result.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function setProgress(value, label = "") {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    progressBar.style.width = `${safeValue}%`;
    progressText.textContent = label || `${safeValue}%`;
}

function clearPolling() {
    if (activePoller) {
        clearInterval(activePoller);
        activePoller = null;
    }
}

function showSection(element, displayValue = "block") {
    if (!element) {
        return;
    }

    element.classList.remove("hidden-section");
    element.style.display = displayValue;
}

function hideSection(element) {
    if (!element) {
        return;
    }

    element.classList.add("hidden-section");
    element.style.display = "none";
}

function renderDownloadState(state) {
    if (!state) {
        return;
    }

    const progress = Number.isFinite(state.progress) ? state.progress : 0;
    const timemark = state.timemark ? ` - ${state.timemark}` : "";
    const label = state.status === "completed"
        ? "100% - Termine"
        : state.status === "cancelled"
            ? "Arrete"
            : state.status === "failed"
                ? "Echec"
                : `${progress}%${timemark}`;

    setProgress(state.status === "completed" ? 100 : progress, label);

    if (state.status === "running" || state.status === "queued") {
        stopBtn.disabled = false;
        setResult({
            message: state.message || "Telechargement en cours",
            jobId: state.jobId,
            status: state.status,
            progress
        });
        return;
    }

    if (state.status === "completed") {
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        setResult({
            message: state.message || "Telechargement termine",
            fileName: state.fileName,
            filePath: state.filePath,
            downloadUrl: state.downloadUrl || "",
            autoDownloaded: state.autoDownloadDone === true
        });
        return;
    }

    if (state.status === "failed") {
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        setResult({
            message: state.message || "Echec",
            error: state.error || "Erreur inconnue"
        });
        return;
    }

    if (state.status === "cancelled") {
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        setResult({
            message: state.message || "Telechargement arrete",
            error: state.error || ""
        });
        return;
    }

    sendBtn.disabled = false;
    stopBtn.disabled = true;
}

function renderActiveJobs(state) {
    const section = document.getElementById("activeSection");
    const countEl = document.getElementById("activeCount");
    const listEl = document.getElementById("activeList");
    const infoEl = document.getElementById("concurrencyInfo");

    if (!section || !countEl || !listEl || !infoEl) {
        return;
    }

    const active = Array.isArray(state?.activeJobs) ? state.activeJobs : [];
    const maxConcurrent = Number.isFinite(state?.maxConcurrent) ? state.maxConcurrent : 1;

    infoEl.textContent = `Concurrence max: ${maxConcurrent}`;
    countEl.textContent = String(active.length);

    if (active.length === 0) {
        hideSection(section);
        listEl.innerHTML = "";
        return;
    }

    showSection(section);
    listEl.innerHTML = active.map((job) => {
        const name = job.fileName || job.jobId || "job";
        const progress = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, Math.round(job.progress))) : 0;
        const status = job.status || "running";
        return `<li><strong>${escapeHtml(name)}</strong> - ${escapeHtml(status)} - ${progress}%</li>`;
    }).join("");
}

async function fetchDownloadState() {
    const response = await chrome.runtime.sendMessage({ type: "getDownloadState" });
    if (response?.ok && response.state) {
        return response.state;
    }

    return null;
}

function renderQueue(items) {
    const section = document.getElementById("queueSection");
    const countEl = document.getElementById("queueCount");
    const listEl = document.getElementById("queueList");

    if (!section || !countEl || !listEl) return;

    countEl.textContent = items.length;
    clearQueueBtn.disabled = items.length === 0;

    if (items.length === 0) {
        hideSection(section);
        listEl.innerHTML = "";
        return;
    }

    showSection(section);
    listEl.innerHTML = items.map((item, i) => {
        const name = item.body?.fileName || item.body?.url || `Item ${i + 1}`;
        return `<li class="queue-item">${escapeHtml(name)}</li>`;
    }).join("");
}

function inferRecentSource(job) {
    if (String(job?.youtubeVideoId || "").trim() || /\/api\/download\/youtube/i.test(String(job?.serverUrl || ""))) {
        return "youtube";
    }
    return "media";
}

function formatRecentStatus(job) {
    switch (job?.status) {
        case "completed":
            return "Termine";
        case "failed":
            return "Echec";
        case "cancelled":
            return "Arrete";
        case "queued":
            return "En attente";
        case "running":
            return "En cours";
        default:
            return job?.status || "Inconnu";
    }
}

function formatRecentPrimaryLine(job, index) {
    const source = inferRecentSource(job);
    if (source === "youtube") {
        return job.fileName || job.message || `Video YouTube ${index + 1}`;
    }
    return job.fileName || job.message || `Video ${index + 1}`;
}

function formatRecentMeta(job) {
    const source = inferRecentSource(job);
    const meta = [];

    if (source === "youtube") {
        meta.push("Source: YouTube");
        if (job.youtubeVideoId) {
            meta.push(`Video ID: ${job.youtubeVideoId}`);
        }
    } else {
        meta.push("Source: MP4 / HLS");
    }

    meta.push(`Statut: ${formatRecentStatus(job)}`);

    if (job.sourceIp) {
        meta.push(`IP: ${job.sourceIp}`);
    }

    if (job.error) {
        meta.push(`Erreur: ${job.error}`);
    } else if (job.message) {
        meta.push(job.message);
    }

    return meta.join(" | ");
}

function renderRecentJobs(items) {
    const section = document.getElementById("recentSection");
    const countEl = document.getElementById("recentCount");
    const listEl = document.getElementById("recentList");

    if (!section || !countEl || !listEl) {
        return;
    }

    const recent = Array.isArray(items) ? items.slice(0, 5) : [];
    countEl.textContent = String(recent.length);

    if (recent.length === 0) {
        hideSection(section);
        hideSection(recentBody);
        listEl.innerHTML = "";
        return;
    }

    showSection(section);
    if (recentExpanded) {
        showSection(recentBody);
    } else {
        hideSection(recentBody);
    }
    listEl.innerHTML = recent.map((job, index) => {
        const source = inferRecentSource(job) === "youtube" ? "YouTube" : "MP4/HLS";
        const primary = formatRecentPrimaryLine(job, index);
        const meta = formatRecentMeta(job);
        return [
            '<li class="recent-item">',
            `<span class="recent-type">${escapeHtml(source)}</span>`,
            `<strong>${escapeHtml(primary)}</strong>`,
            `<span class="recent-meta">${escapeHtml(meta)}</span>`,
            "</li>"
        ].join("");
    }).join("");
}

function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function refreshDownloadState() {
    const [state, queueResp] = await Promise.all([
        fetchDownloadState(),
        chrome.runtime.sendMessage({ type: "getQueue" }).catch(() => null)
    ]);
    if (state) {
        renderDownloadState(state);
        renderActiveJobs(state);
        renderQueue(state.queue || queueResp?.queue || []);
        renderRecentJobs(state.recentJobs || []);
    } else if (queueResp?.ok) {
        renderQueue(queueResp.queue || []);
        renderRecentJobs([]);
    }
}

function startStatePolling() {
    clearPolling();

    activePoller = setInterval(() => {
        refreshDownloadState().catch((_error) => {
            // Ignore transient UI refresh errors.
        });
    }, 1000);
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}

function buildPlaylistUrlFromTab(tab) {
    try {
        const parsed = new URL(tab?.url || "");
        const listId = parsed.searchParams.get("list");
        if (!listId) return "";
        return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
    } catch (_error) {
        return "";
    }
}

async function isActiveTabYouTube(tab) {
    if (!tab?.id) {
        return false;
    }

    try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: "checkYouTube" });
        return response?.ok && response.isYouTube === true;
    } catch (_error) {
        return false;
    }
}

async function loadSettings() {
    const stored = await chrome.storage.local.get(["serverUrl", "apiKey", "referer", "userAgent", "cookie", "videoName"]);
    serverUrlInput.value = stored.serverUrl || DEFAULT_SERVER_URL;
    apiKeyInput.value = stored.apiKey || DEFAULT_API_KEY;
    videoNameInput.value = stored.videoName || "";
    refererInput.value = stored.referer || "";
    userAgentInput.value = stored.userAgent || "";
    cookieInput.value = stored.cookie || "";
}

async function saveSettings() {
    await chrome.storage.local.set({
        serverUrl: serverUrlInput.value.trim(),
        apiKey: apiKeyInput.value.trim(),
        videoName: videoNameInput.value.trim(),
        referer: refererInput.value.trim(),
        userAgent: userAgentInput.value.trim(),
        cookie: cookieInput.value.trim()
    });
}

async function detectFromBackground(tabId) {
    try {
        const response = await chrome.runtime.sendMessage({ type: "getLatestUrl", tabId });

        if (response?.latest) {
            // Handle both old format (string) and new format (object)
            const urlEntry = typeof response.latest === 'string' ? { url: response.latest, context: {} } : response.latest;

            mediaUrlInput.value = urlEntry.url || response.latest;
            showSection(mediaUrlSection);
            currentDetectedContext = { ...(urlEntry.context || {}) };

            // Always refresh header fields to avoid reusing stale cookies from previous sites.
            refererInput.value = urlEntry.context?.referer || "";
            userAgentInput.value = urlEntry.context?.userAgent || "";
            cookieInput.value = urlEntry.context?.cookie || "";

            return true;
        }

        return false;
    } catch (_error) {
        return false;
    }
}

async function detectFromPage(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "scanPage" });

        if (response?.found?.length) {
            mediaUrlInput.value = response.found[0];
            showSection(mediaUrlSection);
            currentDetectedContext = { ...(response.context || {}) };

            refererInput.value = response.context?.referer || "";
            userAgentInput.value = response.context?.userAgent || "";
            cookieInput.value = response.context?.cookie || "";

            return true;
        }

        return false;
    } catch (error) {
        return false;
    }
}

async function autoDetect() {
    try {
        setResult("Detection en cours...");

        const tab = await getActiveTab();

        if (!tab?.id) {
            setResult("Aucun onglet actif.");
            return;
        }

        updateActionButtons(await isActiveTabYouTube(tab));

        if (tab.title) {
            videoNameInput.value = normalizeVideoName(tab.title);
        }

        const fromNetwork = await detectFromBackground(tab.id);

        if (fromNetwork) {
            return;
        }

        const fromPage = await detectFromPage(tab.id);

        if (!fromPage) {
            setResult("Aucune URL video prise en charge detectee sur cette page. Recharge la page puis reclique sur Detecter.");
        }
    } catch (error) {
        setResult(`Detection echouee: ${error.message}`);
    }
}

async function sendToServer() {
    const serverUrl = serverUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    const mediaUrl = mediaUrlInput.value.trim();
    const videoName = normalizeVideoName(videoNameInput.value);
    const referer = refererInput.value.trim();
    const userAgent = userAgentInput.value.trim();
    const cookie = cookieInput.value.trim();

    if (!serverUrl || !apiKey || !mediaUrl) {
        setResult("Renseigne endpoint, API key et URL video.");
        return;
    }

    sendBtn.disabled = true;
    setResult("Ajout a la file d'attente...");

    try {
        const activeTab = await getActiveTab();
        const response = await chrome.runtime.sendMessage({
            type: "addToQueue",
            item: {
                serverUrl,
                apiKey,
                tabId: activeTab?.id ?? -1,
                detectedContext: { ...currentDetectedContext },
                body: {
                    url: mediaUrl,
                    fileName: videoName,
                    headers: {
                        referer,
                        userAgent,
                        cookie,
                        origin: currentDetectedContext.origin || ""
                    }
                }
            }
        });

        if (!response?.ok) {
            setResult({ message: "Echec ajout file", error: response?.error || "Erreur inconnue" });
            sendBtn.disabled = false;
            return;
        }

        const pending = response.queue?.length ?? 0;
        setResult(pending > 0
            ? `Ajoute a la file. ${pending} video(s) en attente.`
            : "Telechargement demarre."
        );
        renderQueue(response.queue || []);
        sendBtn.disabled = false;
        startStatePolling();
    } catch (error) {
        setResult(`Erreur: ${error.message}`);
        sendBtn.disabled = false;
    }
}

async function checkYouTubeDetection() {
    try {
        const response = await chrome.runtime.sendMessage({ type: "getYoutubeVideo" });
        if (response?.ok && response.video?.videoId) {
            youtubeVideoIdEl.textContent = response.video.videoId;
            youtubeVideoTitleEl.textContent = response.video.videoTitle || "";
            showSection(youtubeSection);
            return response.video;
        }
    } catch (_error) { }
    hideSection(youtubeSection);
    return null;
}

async function sendYouTubeToServer() {
    const video = await checkYouTubeDetection();
    if (!video || !video.videoId) {
        setResult("Aucune video YouTube detectee. Ouvre une video YouTube d'abord.");
        return;
    }

    const serverUrl = serverUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!serverUrl || !apiKey) {
        setResult("Renseigne l'endpoint API et la cle API.");
        return;
    }

    youtubeBtn.disabled = true;
    setResult("Ajout YouTube a la file d'attente...");

    try {
        const tab = await getActiveTab();
        const cookie = tab ? await (async () => {
            try {
                const resp = await chrome.runtime.sendMessage({ type: "getLatestUrl", tabId: tab.id });
                return resp?.latest?.context?.cookie || "";
            } catch (_e) { return ""; }
        })() : "";

        const response = await chrome.runtime.sendMessage({
            type: "addYoutubeToQueue",
            item: {
                serverUrl,
                apiKey,
                videoId: video.videoId,
                videoTitle: video.videoTitle || "",
                headers: {
                    referer: video.url || "",
                    userAgent: userAgentInput.value.trim(),
                    cookie: cookie || cookieInput.value.trim()
                }
            }
        });

        if (!response?.ok) {
            setResult({ message: "Echec ajout YouTube", error: response?.error || "Erreur inconnue" });
            youtubeBtn.disabled = false;
            return;
        }

        setResult("Telechargement YouTube demarre.");
        renderQueue(response.queue || []);
        youtubeBtn.disabled = false;
        startStatePolling();
    } catch (error) {
        setResult(`Erreur YouTube: ${error.message}`);
        youtubeBtn.disabled = false;
    }
}

async function queueYouTubePlaylist() {
    const playlistUrl = String(playlistUrlInput.value || "").trim();
    const serverUrl = serverUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!playlistUrl || !serverUrl || !apiKey) {
        setResult("Renseigne l'URL playlist, l'endpoint API et la cle API.");
        return;
    }

    playlistQueueBtn.disabled = true;
    setResult("Analyse de la playlist YouTube...");

    try {
        const tab = await getActiveTab();
        const cookie = tab ? await (async () => {
            try {
                const resp = await chrome.runtime.sendMessage({ type: "getLatestUrl", tabId: tab.id });
                return resp?.latest?.context?.cookie || "";
            } catch (_e) { return ""; }
        })() : "";

        const response = await chrome.runtime.sendMessage({
            type: "addYoutubePlaylistToQueue",
            item: {
                serverUrl,
                apiKey,
                playlistUrl,
                headers: {
                    referer: playlistUrl,
                    userAgent: userAgentInput.value.trim(),
                    cookie: cookie || cookieInput.value.trim()
                }
            }
        });

        if (!response?.ok) {
            setResult({
                message: "Echec playlist YouTube",
                error: response?.error || "URL playlist invalide ou inaccessible"
            });
            playlistQueueBtn.disabled = false;
            return;
        }

        setResult({
            message: `${response.addedCount || 0} video(s) ajoutee(s) depuis la playlist`,
            addedCount: response.addedCount || 0,
            skippedCount: response.skippedCount || 0,
            playlistTitle: response.playlistTitle || ""
        });
        renderQueue(response.queue || []);
        playlistQueueBtn.disabled = false;
        startStatePolling();
    } catch (error) {
        setResult(`Erreur playlist: ${error.message}`);
        playlistQueueBtn.disabled = false;
    }
}

async function stopCurrentDownload() {
    stopBtn.disabled = true;

    try {
        const response = await chrome.runtime.sendMessage({ type: "stopCurrentDownload" });
        if (!response?.ok) {
            setResult({ message: "Echec arret", error: response?.error || "Erreur inconnue" });
            return;
        }

        setResult("Arret du telechargement demande.");
        await refreshDownloadState();
    } catch (error) {
        setResult(`Erreur arret: ${error.message}`);
    } finally {
        stopBtn.disabled = false;
    }
}

async function clearPendingQueue() {
    clearQueueBtn.disabled = true;

    try {
        const response = await chrome.runtime.sendMessage({ type: "clearPendingQueue" });
        if (!response?.ok) {
            setResult({ message: "Echec vidage file", error: response?.error || "Erreur inconnue" });
            return;
        }

        setResult(`${response.clearedCount || 0} element(s) retires de la file.`);
        await refreshDownloadState();
    } catch (error) {
        setResult(`Erreur file: ${error.message}`);
    } finally {
        clearQueueBtn.disabled = false;
    }
}

detectBtn.addEventListener("click", async () => {
    await autoDetect();
    await saveSettings();
});
sendBtn.addEventListener("click", async () => {
    await saveSettings();
    await sendToServer();
});
youtubeBtn.addEventListener("click", async () => {
    await saveSettings();
    await sendYouTubeToServer();
});
playlistBtn.addEventListener("click", async () => {
    const tab = await getActiveTab();
    const guessedPlaylistUrl = buildPlaylistUrlFromTab(tab);
    if (guessedPlaylistUrl && !playlistUrlInput.value.trim()) {
        playlistUrlInput.value = guessedPlaylistUrl;
    }
    if (playlistSection.classList.contains("hidden-section")) {
        showSection(playlistSection);
    } else {
        hideSection(playlistSection);
    }
});
playlistQueueBtn.addEventListener("click", async () => {
    await saveSettings();
    await queueYouTubePlaylist();
});
stopBtn.addEventListener("click", async () => {
    await stopCurrentDownload();
});
clearQueueBtn.addEventListener("click", async () => {
    await clearPendingQueue();
});
recentToggleBtn.addEventListener("click", () => {
    recentExpanded = !recentExpanded;
    if (recentExpanded) {
        showSection(recentBody);
    } else {
        hideSection(recentBody);
    }
});
document.getElementById("saveConfigBtn").addEventListener("click", async () => {
    await saveSettings();
    const statusMsg = document.getElementById("statusMsg");
    if (statusMsg) {
        statusMsg.textContent = "Configuration sauvegardee.";
        setTimeout(() => { statusMsg.textContent = ""; }, 2000);
    }
});

loadSettings().then(async () => {
    const activeTab = await getActiveTab();
    const guessedPlaylistUrl = buildPlaylistUrlFromTab(activeTab);
    if (guessedPlaylistUrl) {
        playlistUrlInput.value = guessedPlaylistUrl;
    }
    updateActionButtons(await isActiveTabYouTube(activeTab));
    await autoDetect();
    await checkYouTubeDetection();
}).catch((error) => {
    setResult(`Initialisation echouee: ${error.message}`);
});

refreshDownloadState().catch((_error) => {
    // Ignore initial state fetch errors.
});

startStatePolling();
