(function () {
    const EVENT_NAME = "media-url-sender:detected";
    const SOURCE_NAME = "media-url-sender";

    function getMediaCandidateKind(url) {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
            return "";
        }

        try {
            const parsed = new URL(url);
            const pathname = parsed.pathname.toLowerCase();
            const search = `${parsed.search}${parsed.hash}`.toLowerCase();
            const combined = `${pathname}${search}`;

            if (/\.m3u8(?:$|[?#])/i.test(url)) {
                return "hls_exact";
            }

            if (/\.mp4(?:$|[?#])/i.test(url)) {
                return "mp4_exact";
            }

            const blockedAssetExt = /\.(?:html?|css|js|json|txt|xml|jpg|jpeg|png|gif|svg|webp|ico|woff2?|ttf|map)$/i;
            if (blockedAssetExt.test(pathname)) {
                return "";
            }

            if (/(^|[/?=_-])(master|manifest|playlist|stream)([/?&=_-]|$)/.test(combined)) {
                return "hls_hint";
            }

            if (/(^|[?&=_-])(format|type|output|mime)=([^#]*m3u8|[^#]*mpegurl|[^#]*mp4)/.test(search)) {
                return /mp4/.test(search) ? "mp4_hint" : "hls_hint";
            }

            if (/(^|[?&=_-])(hls|m3u8|mp4)([=&/_-]|$)/.test(search)) {
                return /mp4/.test(search) ? "mp4_hint" : "hls_hint";
            }
        } catch (_error) {
            return "";
        }

        return "";
    }

    function isSupportedMediaUrl(url) {
        return !!getMediaCandidateKind(url);
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
