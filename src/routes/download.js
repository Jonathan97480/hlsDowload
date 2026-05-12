const express = require("express");
const { requireApiKey } = require("../middleware/auth.middleware");
const {
    handleDownload,
    startDownload,
    getDownloadStatus,
    getDownloadCapacity
} = require("../controllers/download.controller");

const router = express.Router();

router.post("/download", requireApiKey, handleDownload);
router.post("/download/start", requireApiKey, startDownload);
router.get("/download/status/:jobId", requireApiKey, getDownloadStatus);
router.get("/download/capacity", requireApiKey, getDownloadCapacity);

module.exports = router;
