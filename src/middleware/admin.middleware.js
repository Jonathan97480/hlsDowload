const { getSession } = require("../services/admin-store.service");

function readCookie(req, name) {
    const cookieHeader = req.headers.cookie || "";
    const cookies = cookieHeader.split(";").map((part) => part.trim());

    for (const cookie of cookies) {
        const separator = cookie.indexOf("=");
        if (separator === -1) {
            continue;
        }

        const cookieName = cookie.slice(0, separator);
        const cookieValue = cookie.slice(separator + 1);

        if (cookieName === name) {
            return decodeURIComponent(cookieValue);
        }
    }

    return "";
}

function getAdminSession(req) {
    const token = readCookie(req, "admin_session");
    return getSession(token);
}

function requireAdminSession(req, res, next) {
    const session = getAdminSession(req);

    if (!session) {
        return res.status(401).json({
            error: "Acces admin refuse"
        });
    }

    req.adminSession = session;
    return next();
}

module.exports = {
    getAdminSession,
    requireAdminSession
};