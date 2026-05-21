require("dotenv").config();

const path = require("path");
const express = require("express");
const downloadRouter = require("./routes/download");
const adminRouter = require("./routes/admin");
const { applyCors } = require("./middleware/cors.middleware");
const { attachRequestLogger } = require("./middleware/request-logger.middleware");
const { startCleanupSchedule } = require("./services/cleanup.service");
const { restorePendingJobsFromDatabase } = require("./services/download-job.service");
const { initLogger } = require("./services/logger.service");

initLogger();

const app = express();
const port = process.env.PORT || 3000;

app.use(applyCors);
app.use(attachRequestLogger);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use("/api", downloadRouter);
app.use("/api", adminRouter);
app.use("/downloads", express.static(path.resolve(__dirname, "../downloads")));
app.use(express.static(path.resolve(__dirname, "../public")));

app.get("/admin", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "../public/admin.html"));
});

app.get("/api/health", (_req, res) => {
    res.status(200).json({
        ok: true,
        timestamp: new Date().toISOString()
    });
});

app.use((req, res) => {
    res.status(404).json({
        error: `Route introuvable: ${req.method} ${req.originalUrl}`
    });
});

app.listen(port, () => {
    const resumed = restorePendingJobsFromDatabase();
    console.log(`Serveur actif sur http://localhost:${port}`);
    if (resumed > 0) {
        console.log(`[jobs] ${resumed} job(s) en attente repris depuis SQLite.`);
    }
    startCleanupSchedule();
});
