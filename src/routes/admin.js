const express = require("express");
const { requireAdminSession } = require("../middleware/admin.middleware");
const {
    apiKeyRotate,
    apiKeyStatus,
    bootstrap,
    dashboard,
    dashboardStream,
    getSegmentStats,
    jobs,
    login,
    logout,
    profile,
    session,
    settings,
    setup
} = require("../controllers/admin.controller");

const router = express.Router();

router.get("/admin/bootstrap", bootstrap);
router.post("/admin/login", login);
router.post("/admin/setup", setup);
router.post("/admin/logout", requireAdminSession, logout);
router.get("/admin/session", requireAdminSession, session);
router.get("/admin/dashboard", requireAdminSession, dashboard);
router.get("/admin/dashboard/stream", requireAdminSession, dashboardStream);
router.get("/admin/segments", requireAdminSession, getSegmentStats);
router.get("/admin/jobs", requireAdminSession, jobs);
router.get("/admin/api-key/status", requireAdminSession, apiKeyStatus);
router.patch("/admin/settings", requireAdminSession, settings);
router.patch("/admin/profile", requireAdminSession, profile);
router.post("/admin/api-key/rotate", requireAdminSession, apiKeyRotate);

module.exports = router;
