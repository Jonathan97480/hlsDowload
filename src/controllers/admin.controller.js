const { buildDashboardSnapshot, getJobsSnapshot } = require("../services/download-job.service");
const {
    authenticateAdmin,
    clearSetupToken,
    createSession,
    getAdminProfile,
    getBootstrapInfo,
    getSettings,
    getSession,
    revokeSession,
    rotateApiKey,
    setInitialAdmin,
    updateSettings,
    validateSetupToken
} = require("../services/admin-store.service");

function setSessionCookie(res, token) {
    res.setHeader("Set-Cookie", [
        `admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 60 * 60}`
    ]);
}

function clearSessionCookie(res) {
    res.setHeader("Set-Cookie", [
        "admin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    ]);
}

function bootstrap(_req, res) {
    return res.status(200).json(getBootstrapInfo());
}

function login(req, res) {
    const { username, password } = req.body || {};
    const result = authenticateAdmin({ username, password });

    if (!result.ok) {
        return res.status(401).json({ error: result.error });
    }

    if (result.requiresSetup) {
        return res.status(200).json({
            requiresSetup: true,
            setupToken: result.setupToken,
            message: "Mot de passe de demarrage accepte, configuration initiale requise."
        });
    }

    const session = createSession(result.user);
    setSessionCookie(res, session.token);

    return res.status(200).json({
        requiresSetup: false,
        user: session.user,
        message: "Connexion admin reussie."
    });
}

function setup(req, res) {
    const { setupToken, username, password, email } = req.body || {};

    if (!validateSetupToken(setupToken)) {
        return res.status(401).json({ error: "Jeton de configuration invalide ou expire." });
    }

    try {
        const profile = setInitialAdmin({ username, password, email });
        const session = createSession(profile);
        clearSetupToken();
        setSessionCookie(res, session.token);

        return res.status(201).json({
            message: "Compte administrateur cree.",
            user: session.user
        });
    } catch (error) {
        return res.status(400).json({ error: error.message || "Impossible de creer le compte." });
    }
}

function session(req, res) {
    const token = (req.headers.cookie || "").split("admin_session=")[1]?.split(";")[0];
    const currentSession = getSession(token ? decodeURIComponent(token) : "");

    if (!currentSession) {
        return res.status(401).json({ error: "Session admin expiree." });
    }

    return res.status(200).json({ user: currentSession.user, settings: getSettings() });
}

function logout(req, res) {
    const token = (req.headers.cookie || "").split("admin_session=")[1]?.split(";")[0];
    revokeSession(token ? decodeURIComponent(token) : "");
    clearSessionCookie(res);

    return res.status(200).json({ message: "Deconnexion effectuee." });
}

function dashboard(_req, res) {
    const snapshot = buildDashboardSnapshot();
    return res.status(200).json({
        ...snapshot,
        settings: getSettings(),
        admin: getAdminProfile()
    });
}

function dashboardStream(req, res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }

    let lastSignature = "";
    let lastEventAt = 0;

    const writeSnapshot = () => {
        const snapshot = buildDashboardSnapshot();
        const payload = {
            timestamp: Date.now(),
            averageProcessingMs: snapshot.averageProcessingMs,
            averageBandwidthMbps: snapshot.averageBandwidthMbps,
            bandwidthSeries: snapshot.bandwidthSeries,
            activeDownloads: snapshot.activeDownloads,
            queuedDownloads: snapshot.queuedDownloads,
            serverStatus: snapshot.serverStatus,
            cpuPercent: snapshot.cpuPercent,
            memoryPercent: snapshot.memoryPercent,
            jobs: snapshot.jobs,
            settings: getSettings()
        };

        const signature = JSON.stringify({
            averageProcessingMs: payload.averageProcessingMs,
            averageBandwidthMbps: payload.averageBandwidthMbps,
            bandwidthSeries: payload.bandwidthSeries,
            activeDownloads: payload.activeDownloads,
            queuedDownloads: payload.queuedDownloads,
            serverStatus: payload.serverStatus
        });

        if (signature === lastSignature) {
            if (Date.now() - lastEventAt >= 20000) {
                // Keep-alive comment so the SSE connection stays healthy.
                res.write(`: keepalive ${Date.now()}\n\n`);
                lastEventAt = Date.now();
            }
            return;
        }

        lastSignature = signature;
        lastEventAt = Date.now();

        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeSnapshot();
    const intervalId = setInterval(writeSnapshot, 1500);

    req.on("close", () => {
        clearInterval(intervalId);
        res.end();
    });
}

function jobs(_req, res) {
    return res.status(200).json({ jobs: getJobsSnapshot() });
}

function settings(req, res) {
    try {
        const nextSettings = updateSettings(req.body || {});
        return res.status(200).json({
            message: "Parametres mis a jour.",
            settings: nextSettings
        });
    } catch (error) {
        return res.status(400).json({ error: error.message || "Parametres invalides." });
    }
}

function apiKeyRotate(_req, res) {
    const apiKey = rotateApiKey();
    return res.status(200).json({
        message: "Nouvelle cle API generee.",
        apiKey
    });
}

module.exports = {
    apiKeyRotate,
    bootstrap,
    dashboard,
    dashboardStream,
    jobs,
    login,
    logout,
    session,
    settings,
    setup
};