const loginForm = document.getElementById("loginForm");
const setupForm = document.getElementById("setupForm");
const settingsForm = document.getElementById("settingsForm");
const profileForm = document.getElementById("profileForm");
const rotateApiKeyBtn = document.getElementById("rotateApiKeyBtn");
const logoutBtn = document.getElementById("logoutBtn");
const authMessage = document.getElementById("authMessage");
const profileMessage = document.getElementById("profileMessage");
const bootstrapHint = document.getElementById("bootstrapHint");
const setupHint = document.getElementById("setupHint");
const jobsTableBody = document.getElementById("jobsTableBody");
const historyTableBody = document.getElementById("historyTableBody");
const bandwidthCanvas = document.getElementById("bandwidthChart");
const maxConcurrentDownloadsInput = document.getElementById("maxConcurrentDownloads");
const maxTitleLengthInput = document.getElementById("maxTitleLength");
const apiKeyReveal = document.getElementById("apiKeyReveal");
const apiKeyStatusText = document.getElementById("apiKeyStatusText");
const apiKeyUpdatedAt = document.getElementById("apiKeyUpdatedAt");
const profileUsernameInput = document.getElementById("profileUsername");
const profileEmailInput = document.getElementById("profileEmail");
const profileCurrentPasswordInput = document.getElementById("profileCurrentPassword");
const profileNewPasswordInput = document.getElementById("profileNewPassword");
const profileConfirmPasswordInput = document.getElementById("profileConfirmPassword");
const authScreen = document.getElementById("authScreen");
const setupScreen = document.getElementById("setupScreen");
const dashboardScreen = document.getElementById("dashboardScreen");
const setupMessage = document.getElementById("setupMessage");
const backToLoginBtn = document.getElementById("backToLoginBtn");
const passwordToggleButtons = Array.from(document.querySelectorAll("[data-toggle-password]"));
const adminNavButtons = Array.from(document.querySelectorAll(".admin-nav-btn"));
const adminPanels = Array.from(document.querySelectorAll("[data-admin-panel]"));

const serverStatus = document.getElementById("serverStatus");
const cpuRamValue = document.getElementById("cpuRamValue");
const activeJobsValue = document.getElementById("activeJobsValue");
const avgBandwidthValue = document.getElementById("avgBandwidthValue");
const avgProcessingValue = document.getElementById("avgProcessingValue");
const avgGaugeCanvas = document.getElementById("avgGaugeChart");
const queueValue = document.getElementById("queueValue");
const lastRefresh = document.getElementById("lastRefresh");

let setupToken = "";
let dashboardRefreshTimer = null;
let dashboardStream = null;
let dashboardStreamHasData = false;

function formatDuration(ms) {
    if (!ms || ms <= 0) {
        return "--";
    }

    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatBandwidth(value) {
    if (!value) {
        return "0 Mbps";
    }

    return `${Number(value).toFixed(2)} Mbps`;
}

function formatMemory(data) {
    const cpu = Number.isFinite(data.cpuPercent) ? data.cpuPercent : 0;
    const ram = Number.isFinite(data.memoryPercent) ? data.memoryPercent : 0;
    return `${cpu}% CPU · ${ram}% RAM`;
}

function setMessage(message, tone = "info") {
    authMessage.textContent = message;
    authMessage.className = `auth-message auth-message--${tone}`;
}

function setSetupMessage(message, tone = "info") {
    setupMessage.textContent = message;
    setupMessage.className = `auth-message auth-message--${tone}`;
}

function setProfileMessage(message, tone = "info") {
    if (!profileMessage) {
        return;
    }

    profileMessage.textContent = message;
    profileMessage.className = `form-message form-message--${tone}`;
}

function setBootstrapMessage(message) {
    bootstrapHint.textContent = message;
}

function setSetupHint(message) {
    setupHint.textContent = message;
}

function showSetupForm(show) {
    setupScreen.classList.toggle("hidden", !show);
    authScreen.classList.toggle("hidden", show);
}

function showDashboard(show) {
    authScreen.classList.toggle("hidden", show);
    setupScreen.classList.toggle("hidden", true);
    dashboardScreen.classList.toggle("hidden", !show);

    if (show) {
        setActivePanel("dashboard");
    }
}

function showLoginScreen() {
    authScreen.classList.remove("hidden");
    setupScreen.classList.add("hidden");
    dashboardScreen.classList.add("hidden");
}

function showSetupScreen() {
    authScreen.classList.add("hidden");
    setupScreen.classList.remove("hidden");
    dashboardScreen.classList.add("hidden");
}

function togglePasswordVisibility(inputId, button) {
    const input = document.getElementById(inputId);

    if (!input) {
        return;
    }

    const nextType = input.type === "password" ? "text" : "password";
    input.type = nextType;
    button.textContent = nextType === "password" ? "👁" : "🙈";
}

function setActivePanel(panelName) {
    adminPanels.forEach((panel) => {
        panel.classList.toggle("hidden", panel.dataset.adminPanel !== panelName);
    });

    adminNavButtons.forEach((button) => {
        button.classList.toggle("active", button.dataset.panel === panelName);
    });
}

function syncAdminProfile(user) {
    if (!user) {
        return;
    }

    profileUsernameInput.value = user.username || "";
    profileEmailInput.value = user.email || "";

    const name = user.username || "Admin";
    const sidebarEl = document.getElementById("sidebarUsername");
    const navbarEl = document.getElementById("navbarUsername");
    if (sidebarEl) sidebarEl.textContent = name;
    if (navbarEl) navbarEl.textContent = name;
}

function buildModeBadge(job) {
    const mode = (job?.ffmpegMode || "").toLowerCase();

    if (mode === "transcode") {
        return '<span class="mode-badge mode-badge-fallback" title="Mode fallback FFmpeg utilise (transcodage)">🛠 Fallback</span>';
    }

    if (mode === "copy") {
        return '<span class="mode-badge mode-badge-standard" title="Mode standard FFmpeg (copy)">✔ Standard</span>';
    }

    return '<span class="mode-badge mode-badge-unknown" title="Mode FFmpeg non disponible">? Inconnu</span>';
}

function renderJobs(jobs) {
    if (!jobs || jobs.length === 0) {
        jobsTableBody.innerHTML = '<tr><td colspan="4" class="px-4 py-6 text-center text-slate-400">Aucun job recent.</td></tr>';
        return;
    }

    jobsTableBody.innerHTML = jobs.map((job) => {
        const statusClass = job.status === "completed"
            ? "pill-completed"
            : job.status === "failed"
                ? "pill-failed"
                : job.status === "running"
                    ? "pill-running"
                    : "pill-queued";
        const progressBar = job.status === "running" || job.status === "queued"
            ? `<div class="lte-progress"><div class="lte-progress-bar" style="width:${job.progress || 0}%"></div></div>`
            : "";

        return `
          <tr>
            <td>
              <div class="job-user">${job.clientId || job.sourceIp || "unknown"}</div>
              <div class="job-ip">${job.sourceIp || ""}</div>
            </td>
            <td>
              <div class="job-file">${job.fileName || job.preferredName || "En attente"}</div>
                            <div class="job-quality">${job.quality || "qualite inconnue"} · ${buildModeBadge(job)}</div>
            </td>
            <td>
              <div>Flux: ${formatDuration(job.durationMs || 0)}</div>
              <div>Reel: ${formatDuration((job.completedAt || Date.now()) - (job.startedAt || job.updatedAt || Date.now()))}</div>
              ${progressBar}
            </td>
            <td>
              <span class="status-pill ${statusClass}">${job.status}</span>
              <div class="job-msg">${job.message || ""}</div>
            </td>
          </tr>
        `;
    }).join("");
}

function renderHistory(history) {
    if (!historyTableBody) {
        return;
    }

    const list = Array.isArray(history)
        ? history.filter((job) => job.status === "completed" || job.status === "failed")
        : [];

    if (list.length === 0) {
        historyTableBody.innerHTML = '<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">Aucun historique disponible.</td></tr>';
        return;
    }

    historyTableBody.innerHTML = list.map((job) => {
        const finishedAt = job.completedAt || job.updatedAt || 0;
        const dateLabel = finishedAt ? new Date(finishedAt).toLocaleString() : "--";
        const statusClass = job.status === "completed" ? "pill-completed" : "pill-failed";

        return `
                    <tr>
                        <td>${dateLabel}</td>
                        <td>
                            <div class="job-user">${job.clientId || "unknown"}</div>
                            <div class="job-ip">${job.sourceIp || ""}</div>
                        </td>
                        <td>
                            <div class="job-file">${job.fileName || job.preferredName || "--"}</div>
                            <div class="job-msg">${job.message || ""}</div>
                        </td>
                        <td>${buildModeBadge(job)}</td>
                        <td><span class="status-pill ${statusClass}">${job.status}</span></td>
                    </tr>
                `;
    }).join("");
}

function renderDashboard(data) {
    serverStatus.textContent = data.serverStatus || "Idle";
    serverStatus.className = data.serverStatus === "Busy"
        ? "lte-stat-value stat-busy"
        : "lte-stat-value";

    cpuRamValue.textContent = formatMemory(data);
    activeJobsValue.textContent = `${data.activeDownloads || 0} actifs`;
    avgBandwidthValue.textContent = formatBandwidth(data.averageBandwidthMbps || 0);
    avgProcessingValue.textContent = formatDuration(data.averageProcessingMs || 0);
    queueValue.textContent = `${data.queuedDownloads || 0} en file`;
    maxConcurrentDownloadsInput.value = data.settings?.maxConcurrentDownloads || 3;
    maxTitleLengthInput.value = data.settings?.maxTitleLength || 500;

    if (window.createGaugeChart) {
        try {
            const averageMinutes = Math.min(Math.ceil((data.averageProcessingMs || 0) / 60000), 60);
            window.createGaugeChart(avgGaugeCanvas, averageMinutes, 60);
        } catch (_error) {
            // Continue rendering other dashboard blocks even if one chart fails.
        }
    }

    const series = data.bandwidthSeries || [];
    if (window.createBandwidthChart) {
        try {
            window.createBandwidthChart(bandwidthCanvas, series.map((item) => item.label), series.map((item) => item.value));
        } catch (_error) {
            // Keep textual metrics and tables updated even if chart rendering fails.
        }
    }

    lastRefresh.textContent = `Mise a jour: ${new Date().toLocaleString()}`;
    renderJobs(data.jobs || []);
    renderHistory(data.history || []);
    syncAdminProfile(data.admin);

    if (window.updateSegmentStats) {
        window.updateSegmentStats(data.segmentStats || {
            totalSegments: data.totalSegments,
            corruptedSegments: data.corruptedSegments,
            retryAttempts: data.retryAttempts
        });
    }
}

function renderApiKeyStatus(status) {
    if (!apiKeyStatusText || !apiKeyUpdatedAt) {
        return;
    }

    if (!status?.hasApiKey) {
        apiKeyStatusText.textContent = "Aucune cle API active.";
        apiKeyUpdatedAt.textContent = "Source: aucune";
        return;
    }

    apiKeyStatusText.textContent = `Cle active: ${status.maskedApiKey} (${status.source || "inconnue"})`;
    apiKeyUpdatedAt.textContent = status.updatedAt
        ? `Derniere rotation: ${new Date(status.updatedAt).toLocaleString()}`
        : "Derniere rotation: inconnue";
}

function stopDashboardAutoRefresh() {
    if (dashboardRefreshTimer) {
        window.clearInterval(dashboardRefreshTimer);
        dashboardRefreshTimer = null;
    }
}

function startDashboardAutoRefresh() {
    stopDashboardAutoRefresh();
    dashboardRefreshTimer = window.setInterval(async () => {
        if (dashboardScreen.classList.contains("hidden")) {
            return;
        }

        try {
            await loadDashboard();
        } catch (error) {
            if (error && error.status === 401) {
                stopDashboardAutoRefresh();
                showLoginScreen();
                setMessage("Session admin expiree. Reconnectez-vous.", "error");
                return;
            }

            setMessage("Le dashboard admin n'a pas pu etre rafraichi. Nouvelle tentative automatique...", "error");
        }
    }, 5000);
}

function applyRealtimeDashboard(data) {
    renderDashboard(data);
    settingsForm.dataset.loaded = "true";
}

function stopDashboardStream() {
    if (dashboardStream) {
        dashboardStream.close();
        dashboardStream = null;
    }
}

function startDashboardStream() {
    stopDashboardStream();
    dashboardStreamHasData = false;

    dashboardStream = new EventSource("/api/admin/dashboard/stream");

    dashboardStream.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data || "{}");
            dashboardStreamHasData = true;
            stopDashboardAutoRefresh();
            applyRealtimeDashboard(payload);
        } catch (_error) {
            // Ignore malformed SSE payloads and wait for next event.
        }
    };

    dashboardStream.onerror = async () => {
        stopDashboardStream();

        if (!dashboardScreen.classList.contains("hidden")) {
            if (dashboardStreamHasData) {
                setMessage("Flux temps reel interrompu, bascule en mode rafraichissement.", "error");
            }

            try {
                await loadDashboard();
            } catch (_error) {
                // Ignore immediate fallback load failure; timer below will retry.
            }

            startDashboardAutoRefresh();
        }
    };
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        },
        ...options
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const error = new Error(payload.error || "Requete echouee");
        error.payload = payload;
        error.status = response.status;
        throw error;
    }

    return payload;
}

async function loadBootstrap() {
    const bootstrap = await fetchJson("/api/admin/bootstrap");
    if (bootstrap.setupRequired) {
        setBootstrapMessage(`Configuration initiale requise. Le mot de passe de demarrage est actif et le pseudo par defaut est ${bootstrap.defaultUsername}.`);
        setSetupHint(`Utilise d'abord le mot de passe de demarrage, puis cree le compte admin definitif pour ${bootstrap.defaultUsername}.`);
        showSetupForm(false);
        return;
    }

    setBootstrapMessage("Connexion admin disponible. Utilisez votre pseudo et votre mot de passe.");
    setSetupHint("Creez ici les identifiants definitifs du compte administrateur.");
}

async function loadSession() {
    try {
        const session = await fetchJson("/api/admin/session");
        setMessage(`Connecte en tant que ${session.user.username}.`, "success");
        syncAdminProfile(session.user);
        showDashboard(true);
        return session;
    } catch (_error) {
        showDashboard(false);
        return null;
    }
}

async function loadDashboard() {
    const dashboard = await fetchJson("/api/admin/dashboard");
    renderDashboard(dashboard);
    settingsForm.dataset.loaded = "true";
}

async function loadApiKeyStatus() {
    const status = await fetchJson("/api/admin/api-key/status");
    renderApiKeyStatus(status);
}

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!username || !password) {
        setMessage("Renseignez le pseudo et le mot de passe.", "error");
        return;
    }

    try {
        const result = await fetchJson("/api/admin/login", {
            method: "POST",
            body: JSON.stringify({ username, password })
        });

        if (result.requiresSetup) {
            setupToken = result.setupToken;
            showSetupScreen();
            document.getElementById("setupUsername").value = username;
            setMessage("Mot de passe de demarrage accepte. Completez la premiere configuration.", "success");
            setSetupMessage("Renseignez maintenant les identifiants definitifs du compte admin.", "info");
            return;
        }

        setMessage(result.message || "Connexion admin reussie.", "success");
        showSetupForm(false);
        showDashboard(true);
        await loadDashboard();
        await loadApiKeyStatus();
        startDashboardStream();
    } catch (error) {
        setMessage(error.message, "error");
        stopDashboardAutoRefresh();
        stopDashboardStream();
        showDashboard(false);
    }
});

setupForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = document.getElementById("setupUsername").value.trim();
    const email = document.getElementById("setupEmail").value.trim();
    const password = document.getElementById("setupPassword").value;
    const passwordConfirm = document.getElementById("setupPasswordConfirm").value;

    if (!password || !passwordConfirm) {
        setSetupMessage("Renseignez le nouveau mot de passe et sa confirmation.", "error");
        return;
    }

    if (password !== passwordConfirm) {
        setSetupMessage("La confirmation du mot de passe ne correspond pas.", "error");
        return;
    }

    try {
        const result = await fetchJson("/api/admin/setup", {
            method: "POST",
            body: JSON.stringify({ setupToken, username, email, password })
        });

        setMessage(result.message || "Compte admin cree.", "success");
        setSetupMessage(result.message || "Compte admin cree.", "success");
        showSetupForm(false);
        showDashboard(true);
        await loadDashboard();
        await loadApiKeyStatus();
        startDashboardStream();
    } catch (error) {
        setSetupMessage(error.message, "error");
    }
});

backToLoginBtn.addEventListener("click", () => {
    setSetupMessage("En attente...");
    stopDashboardAutoRefresh();
    stopDashboardStream();
    showLoginScreen();
});

passwordToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
        togglePasswordVisibility(button.dataset.togglePassword, button);
    });
});

adminNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
        setActivePanel(button.dataset.panel);
    });
});

profileForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = profileEmailInput.value.trim();
    const currentPassword = profileCurrentPasswordInput.value;
    const newPassword = profileNewPasswordInput.value;
    const confirmPassword = profileConfirmPasswordInput.value;

    if ((newPassword || confirmPassword) && newPassword !== confirmPassword) {
        setProfileMessage("La confirmation du nouveau mot de passe ne correspond pas.", "error");
        return;
    }

    if ((newPassword || confirmPassword) && !currentPassword) {
        setProfileMessage("Renseignez le mot de passe actuel pour changer le mot de passe.", "error");
        return;
    }

    try {
        const payload = { email };

        if (newPassword) {
            payload.currentPassword = currentPassword;
            payload.newPassword = newPassword;
        }

        const result = await fetchJson("/api/admin/profile", {
            method: "PATCH",
            body: JSON.stringify(payload)
        });

        syncAdminProfile(result.user);
        profileCurrentPasswordInput.value = "";
        profileNewPasswordInput.value = "";
        profileConfirmPasswordInput.value = "";
        setProfileMessage(result.message || "Profil administrateur mis a jour.", "success");
        setMessage(result.message || "Profil administrateur mis a jour.", "success");
    } catch (error) {
        setProfileMessage(error.message, "error");
    }
});

settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
        const result = await fetchJson("/api/admin/settings", {
            method: "PATCH",
            body: JSON.stringify({
                maxConcurrentDownloads: maxConcurrentDownloadsInput.value,
                maxTitleLength: maxTitleLengthInput.value
            })
        });

        setMessage(result.message || "Parametres enregistres.", "success");
        await loadDashboard();
    } catch (error) {
        setMessage(error.message, "error");
    }
});

rotateApiKeyBtn.addEventListener("click", async () => {
    try {
        const result = await fetchJson("/api/admin/api-key/rotate", {
            method: "POST"
        });

        apiKeyReveal.textContent = `Nouvelle cle API: ${result.apiKey}`;
        apiKeyReveal.classList.remove("hidden");
        await loadApiKeyStatus();
        setMessage("Nouvelle cle API generee et affichee une seule fois.", "success");
    } catch (error) {
        setMessage(error.message, "error");
    }
});

logoutBtn.addEventListener("click", async () => {
    try {
        await fetchJson("/api/admin/logout", { method: "POST" });
        setMessage("Deconnecte.", "success");
        apiKeyReveal.classList.add("hidden");
        stopDashboardAutoRefresh();
        stopDashboardStream();
        showLoginScreen();
        await loadBootstrap();
    } catch (error) {
        setMessage(error.message, "error");
    }
});

async function init() {
    try {
        await loadBootstrap();
        const session = await loadSession();
        if (session) {
            await loadDashboard();
            await loadApiKeyStatus();
            startDashboardStream();
        } else {
            stopDashboardAutoRefresh();
            stopDashboardStream();
            showLoginScreen();
        }
    } catch (_error) {
        setBootstrapMessage("Authentification requise ou serveur indisponible.");
        setMessage("Connectez-vous pour afficher les donnees.");
        stopDashboardAutoRefresh();
        stopDashboardStream();
        showLoginScreen();
        renderJobs([]);
    }
}

init();
