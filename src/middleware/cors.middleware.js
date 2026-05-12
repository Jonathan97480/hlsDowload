function isAllowedOrigin(origin) {
    if (!origin) {
        return false;
    }

    if (/^chrome-extension:\/\//i.test(origin)) {
        return true;
    }

    if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) {
        return true;
    }

    if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) {
        return true;
    }

    return false;
}

function applyCors(req, res, next) {
    const origin = req.headers.origin;

    if (isAllowedOrigin(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header("Vary", "Origin");
    }

    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type,x-api-key");

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    return next();
}

module.exports = {
    applyCors
};
