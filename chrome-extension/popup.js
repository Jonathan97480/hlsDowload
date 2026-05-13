const serverUrlInput = document.getElementById("serverUrl");
const apiKeyInput = document.getElementById("apiKey");
const mediaUrlInput = document.getElementById("mediaUrl");
const videoNameInput = document.getElementById("videoName");
const refererInput = document.getElementById("referer");
const userAgentInput = document.getElementById("userAgent");
const cookieInput = document.getElementById("cookie");
const detectBtn = document.getElementById("detectBtn");
const sendBtn = document.getElementById("sendBtn");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const result = document.getElementById("result");
const mediaUrlSection = document.getElementById("mediaUrlSection");
const activeSection = document.getElementById("activeSection");
const queueSection = document.getElementById("queueSection");

const DEFAULT_SERVER_URL = "http://localhost:3000/api/download";
const DEFAULT_API_KEY = "125456Aprt";
let activePoller = null;

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
        : state.status === "failed"
            ? "Echec"
            : `${progress}%${timemark}`;

    setProgress(state.status === "completed" ? 100 : progress, label);

    if (state.status === "running" || state.status === "queued") {
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
        setResult({
            message: state.message || "Echec",
            error: state.error || "Erreur inconnue"
        });
        return;
    }

    sendBtn.disabled = false;
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
    } else if (queueResp?.ok) {
        renderQueue(queueResp.queue || []);
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

            // Auto-fill headers from captured context
            if (urlEntry.context?.referer) {
                refererInput.value = urlEntry.context.referer;
            }
            if (urlEntry.context?.userAgent) {
                userAgentInput.value = urlEntry.context.userAgent;
            }
            if (urlEntry.context?.cookie) {
                cookieInput.value = urlEntry.context.cookie;
            }

            return true;
        }

        return false;
    } catch (_error) {
        return false;
    }
}

async function detectFromPage(tabId) {
    let response = null;

    try {
        response = await chrome.tabs.sendMessage(tabId, { type: "scanPage" });
    } catch (error) {
        const message = String(error?.message || "");

        if (!message.includes("Receiving end does not exist")) {
            return false;
        }

        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ["content-script.js"]
            });

            response = await chrome.tabs.sendMessage(tabId, { type: "scanPage" });
        } catch (_injectError) {
            return false;
        }
    }

    if (response?.found?.length) {
        mediaUrlInput.value = response.found[0];
        showSection(mediaUrlSection);

        // Auto-fill referer from document context if available
        if (response.context?.referer) {
            refererInput.value = response.context.referer;
        }
        if (response.context?.userAgent) {
            userAgentInput.value = response.context.userAgent;
        }
        if (response.context?.cookie) {
            cookieInput.value = response.context.cookie;
        }

        return true;
    }

    return false;
}

async function autoDetect() {
    try {
        setResult("Detection en cours...");

        const tab = await getActiveTab();

        if (!tab?.id) {
            setResult("Aucun onglet actif.");
            return;
        }

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
        const response = await chrome.runtime.sendMessage({
            type: "addToQueue",
            item: {
                serverUrl,
                apiKey,
                body: {
                    url: mediaUrl,
                    fileName: videoName,
                    headers: { referer, userAgent, cookie }
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

detectBtn.addEventListener("click", async () => {
    await autoDetect();
    await saveSettings();
});
sendBtn.addEventListener("click", async () => {
    await saveSettings();
    await sendToServer();
});
document.getElementById("saveConfigBtn").addEventListener("click", async () => {
    await saveSettings();
    const statusMsg = document.getElementById("statusMsg");
    if (statusMsg) {
        statusMsg.textContent = "Configuration sauvegardee.";
        setTimeout(() => { statusMsg.textContent = ""; }, 2000);
    }
});

loadSettings().then(autoDetect).catch((error) => {
    setResult(`Initialisation echouee: ${error.message}`);
});

refreshDownloadState().catch((_error) => {
    // Ignore initial state fetch errors.
});

startStatePolling();
