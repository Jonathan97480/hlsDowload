const { getActiveApiKey } = require("../services/admin-store.service");

function requireApiKey(req, res, next) {
    const expectedApiKey = getActiveApiKey() || process.env.API_KEY;

    if (!expectedApiKey) {
        return res.status(500).json({
            error: "Configuration serveur invalide: API_KEY absente"
        });
    }

    const providedApiKey = req.header("x-api-key");

    if (!providedApiKey || providedApiKey !== expectedApiKey) {
        return res.status(401).json({
            error: "Acces refuse: x-api-key invalide"
        });
    }

    next();
}

module.exports = {
    requireApiKey
};
