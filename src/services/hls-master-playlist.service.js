function parseAttributeList(input = "") {
    const attributes = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match = pattern.exec(input);

    while (match) {
        const key = match[1];
        const rawValue = match[2] || "";
        attributes[key] = rawValue.startsWith("\"") ? rawValue.slice(1, -1) : rawValue;
        match = pattern.exec(input);
    }

    return attributes;
}

function parseMediaRenditions(lines) {
    return lines
        .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
        .map((line) => parseAttributeList(line.slice("#EXT-X-MEDIA:".length)))
        .filter((attributes) => attributes.TYPE === "AUDIO" && attributes["GROUP-ID"]);
}

function parseVariants(lines) {
    const variants = [];

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.startsWith("#EXT-X-STREAM-INF:")) {
            continue;
        }

        const attributes = parseAttributeList(line.slice("#EXT-X-STREAM-INF:".length));
        const url = lines[index + 1]?.trim();
        if (!url || url.startsWith("#")) {
            continue;
        }

        const resolution = attributes.RESOLUTION?.match(/(\d+)x(\d+)/);
        const bandwidth = Number.parseInt(attributes["AVERAGE-BANDWIDTH"] || attributes.BANDWIDTH, 10) || 0;
        const codecs = String(attributes.CODECS || "").toLowerCase();
        const hasEmbeddedAudio = /mp4a|ac-3|ec-3|opus/.test(codecs);

        variants.push({
            url,
            bandwidth,
            audioGroupId: attributes.AUDIO || "",
            hasEmbeddedAudio,
            resolution: resolution ? { width: Number.parseInt(resolution[1], 10), height: Number.parseInt(resolution[2], 10) } : null,
            pixels: resolution ? Number.parseInt(resolution[1], 10) * Number.parseInt(resolution[2], 10) : 0
        });
    }

    return variants;
}

function enrichVariants(variants, renditions) {
    return variants.map((variant) => {
        const audioRenditions = renditions.filter((entry) => entry["GROUP-ID"] === variant.audioGroupId);
        const hasExternalAudio = audioRenditions.length > 0;

        return {
            ...variant,
            audioRenditions,
            hasUsableAudio: variant.hasEmbeddedAudio || hasExternalAudio,
            requiresExternalAudio: !variant.hasEmbeddedAudio && hasExternalAudio
        };
    });
}

function parseMasterPlaylist(content = "") {
    const lines = String(content).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const audioRenditions = parseMediaRenditions(lines);
    const variants = enrichVariants(parseVariants(lines), audioRenditions);

    return {
        audioRenditions,
        variants
    };
}

module.exports = {
    parseMasterPlaylist
};
