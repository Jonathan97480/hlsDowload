const loginForm = document.getElementById("loginForm");
const setupForm = document.getElementById("setupForm");
const settingsForm = document.getElementById("settingsForm");
const rotateApiKeyBtn = document.getElementById("rotateApiKeyBtn");
const logoutBtn = document.getElementById("logoutBtn");
const authMessage = document.getElementById("authMessage");
const bootstrapHint = document.getElementById("bootstrapHint");
const setupHint = document.getElementById("setupHint");
const jobsTableBody = document.getElementById("jobsTableBody");
const bandwidthCanvas = document.getElementById("bandwidthChart");
const maxConcurrentDownloadsInput = document.getElementById("maxConcurrentDownloads");
const apiKeyReveal = document.getElementById("apiKeyReveal");
const authScreen = document.getElementById("authScreen");
const setupScreen = document.getElementById("setupScreen");
const dashboardScreen = document.getElementById("dashboardScreen");
const setupMessage = document.getElementById("setupMessage");
const backToLoginBtn = document.getElementById("backToLoginBtn");
const passwordToggleButtons = Array.from(document.querySelectorAll("[data-toggle-password]"));

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

function hasAdminSessionCookie() {
    return document.cookie.split(";").some((part) => part.trim().startsWith("admin_session="));
}

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
    authMessage.className = "mt-4 rounded-2xl border px-4 py-3 text-sm";

    if (tone === "error") {
        authMessage.classList.add("border-rose-400/40", "bg-rose-400/10", "text-rose-100");
        return;
    }

    if (tone === "success") {
        authMessage.classList.add("border-emerald-400/40", "bg-emerald-400/10", "text-emerald-100");
        return;
    }

    authMessage.classList.add("border-slate-700", "bg-slate-950/45", "text-slate-300");
}

function setSetupMessage(message, tone = "info") {
    setupMessage.textContent = message;
    setupMessage.className = "mt-4 rounded-2xl border px-4 py-3 text-sm";

    if (tone === "error") {
        setupMessage.classList.add("border-rose-400/40", "bg-rose-400/10", "text-rose-100");
        return;
    }

    if (tone === "success") {
        setupMessage.classList.add("border-emerald-400/40", "bg-emerald-400/10", "text-emerald-100");
        return;
    }

    setupMessage.classList.add("border-slate-700", "bg-slate-950/45", "text-slate-300");
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

function renderJobs(jobs) {
    if (!jobs || jobs.length === 0) {
        jobsTableBody.innerHTML = '<tr><td colspan="4" class="px-4 py-6 text-center text-slate-400">Aucun job recent.</td></tr>';
        return;
    }

    jobsTableBody.innerHTML = jobs.map((job) => {
        const statusClass = job.status === "completed"
            ? "bg-emerald-400/15 text-emerald-200 border-emerald-400/30"
            : job.status === "failed"
                ? "bg-rose-400/15 text-rose-200 border-rose-400/30"
                : "bg-amber-400/15 text-amber-200 border-amber-400/30";
        const progressBar = job.status === "running" || job.status === "queued"
            ? `<div class="mt-2 h-2 w-40 overflow-hidden rounded-full bg-slate-700"><div class="h-full rounded-full bg-cyan-400" style="width:${job.progress || 0}%"></div></div>`
            : "";

        return `
          <tr class="align-top">
            <td class="px-4 py-4">
              <div class="font-semibold text-slate-100">${job.clientId || job.sourceIp || "unknown"}</div>
              <div class="text-xs text-slate-400">${job.sourceIp || ""}</div>
            </td>
            <td class="px-4 py-4">
              <div class="font-semibold text-slate-100">${job.fileName || job.preferredName || "En attente"}</div>
              <div class="text-xs text-slate-400">${job.quality || "qualite inconnue"}</div>
            </td>
            <td class="px-4 py-4 text-slate-300">
              <div>Flux: ${formatDuration(job.durationMs || 0)}</div>
              <div>Real: ${formatDuration((job.completedAt || Date.now()) - (job.startedAt || job.updatedAt || Date.now()))}</div>
              ${progressBar}
            </td>
            <td class="px-4 py-4">
              <span class="status-pill inline-flex rounded-full border px-3 py-1 text-xs font-bold ${statusClass}">${job.status}</span>
              <div class="mt-2 text-xs text-slate-400">${job.message || ""}</div>
            </td>
          </tr>
        `;
    }).join("");
}

function renderDashboard(data) {
    serverStatus.textContent = data.serverStatus || "Idle";
    serverStatus.className = data.serverStatus === "Busy"
        ? "mt-1 text-lg font-bold text-amber-300"
        : "mt-1 text-lg font-bold text-emerald-300";

    cpuRamValue.textContent = formatMemory(data);
    activeJobsValue.textContent = `${data.activeDownloads || 0} actifs`;
    avgBandwidthValue.textContent = formatBandwidth(data.averageBandwidthMbps || 0);
    avgProcessingValue.textContent = formatDuration(data.averageProcessingMs || 0);
    queueValue.textContent = `${data.queuedDownloads || 0} en file`;
    maxConcurrentDownloadsInput.value = data.settings?.maxConcurrentDownloads || 3;

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

settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
        const result = await fetchJson("/api/admin/settings", {
            method: "PATCH",
            body: JSON.stringify({
                maxConcurrentDownloads: maxConcurrentDownloadsInput.value
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
        if (hasAdminSessionCookie()) {
            const session = await loadSession();
            if (session) {
                await loadDashboard();
                startDashboardStream();
            } else {
                stopDashboardAutoRefresh();
                stopDashboardStream();
                showLoginScreen();
            }
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