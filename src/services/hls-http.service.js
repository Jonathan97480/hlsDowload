const http = require("http");
const https = require("https");

function chooseTransport(url) {
    return url.startsWith("https://") ? https : http;
}

function mergeHeaders(headers = {}) {
    return {
        "User-Agent": "Mozilla/5.0",
        ...headers
    };
}

function fetchHlsText(url, headers = {}, options = {}, redirectCount = 0) {
    const transport = chooseTransport(url);
    const timeoutMs = options.timeoutMs || 20000;
    const maxRedirects = options.maxRedirects || 5;
    const mergedHeaders = mergeHeaders(headers);

    return new Promise((resolve, reject) => {
        const request = transport.get(url, { headers: mergedHeaders }, (response) => {
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;

            if (statusCode >= 300 && statusCode < 400 && location) {
                response.resume();

                if (redirectCount >= maxRedirects) {
                    reject(new Error("Trop de redirections sur la ressource HLS"));
                    return;
                }

                const nextUrl = new URL(location, url).href;
                fetchHlsText(nextUrl, headers, options, redirectCount + 1).then(resolve).catch(reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`Lecture HLS refusee (${statusCode})`));
                return;
            }

            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                data += chunk;
            });
            response.on("end", () => resolve(data));
            response.on("error", (error) => reject(new Error(`Erreur lecture HLS: ${error.message}`)));
        });

        request.setTimeout(timeoutMs, () => {
            request.destroy(new Error("Timeout sur la ressource HLS"));
        });
        request.on("error", (error) => reject(new Error(`Erreur requete HLS: ${error.message}`)));
    });
}

module.exports = {
    fetchHlsText,
    mergeHeaders
};
