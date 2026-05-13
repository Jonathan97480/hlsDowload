(function () {
    const EVENT_NAME = "media-url-sender:detected";
    const SOURCE_NAME = "media-url-sender";

    function isSupportedMediaUrl(url) {
        return /^https?:\/\//i.test(url) && /\.(m3u8|mp4)(\?.*)?$/i.test(url);
    }

    function emit(url, channel, extras = {}) {
        if (!isSupportedMediaUrl(url)) {
            return;
        }

        window.dispatchEvent(new CustomEvent(EVENT_NAME, {
            detail: {
                source: SOURCE_NAME,
                url,
                channel,
                ...extras
            }
        }));
    }

    function normalizeUrl(input) {
        if (typeof input !== "string" || !input.trim()) {
            return "";
        }

        try {
            return new URL(input, window.location.href).href;
        } catch (_error) {
            return "";
        }
    }

    function extractUrl(input) {
        if (typeof input === "string") {
            return normalizeUrl(input);
        }

        if (input instanceof Request) {
            return normalizeUrl(input.url);
        }

        if (input && typeof input.url === "string") {
            return normalizeUrl(input.url);
        }

        return "";
    }

    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
        window.fetch = function (...args) {
            const url = extractUrl(args[0]);
            if (url) {
                emit(url, "fetch", { method: String(args[1]?.method || "GET").toUpperCase() });
            }

            return originalFetch.apply(this, args);
        };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        const normalizedUrl = extractUrl(url);
        if (normalizedUrl) {
            emit(normalizedUrl, "xhr", { method: String(method || "GET").toUpperCase() });
        }

        return originalOpen.call(this, method, url, ...rest);
    };
})();
