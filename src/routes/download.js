const express = require("express");
const { requireApiKey } = require("../middleware/auth.middleware");
const {
    handleDownload,
    startDownload,
    getDownloadStatus,
    getDownloadCapacity,
    stopDownloadJob,
    clearDownloadQueue
} = require("../controllers/download.controller");
const {
    handleYouTubeDownload,
    startYouTubeDownload,
    getYouTubeStatus,
    listYouTubePlaylist
} = require("../controllers/youtube.controller");

const router = express.Router();

router.post("/download", requireApiKey, handleDownload);
router.post("/download/start", requireApiKey, startDownload);
router.get("/download/status/:jobId", requireApiKey, getDownloadStatus);
router.get("/download/capacity", requireApiKey, getDownloadCapacity);
router.post("/download/control/stop/:jobId", requireApiKey, stopDownloadJob);
router.post("/download/control/clear-queue", requireApiKey, clearDownloadQueue);

router.post("/download/youtube", requireApiKey, handleYouTubeDownload);
router.post("/download/youtube/start", requireApiKey, startYouTubeDownload);
router.post("/download/youtube/playlist", requireApiKey, listYouTubePlaylist);
router.get("/download/youtube/status/:jobId", requireApiKey, getYouTubeStatus);

module.exports = router;
