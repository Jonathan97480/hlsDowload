const submitBtn = document.getElementById("submitBtn");
const apiKeyInput = document.getElementById("apiKey");
const hlsUrlInput = document.getElementById("hlsUrl");
const resultDiv = document.getElementById("result");

function render(payload) {
    resultDiv.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

submitBtn.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    const url = hlsUrlInput.value.trim();

    if (!apiKey || !url) {
        render("Veuillez renseigner la cle API et l'URL HLS.");
        return;
    }

    submitBtn.disabled = true;
    render("Traitement en cours...");

    try {
        const response = await fetch("/api/download", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey
            },
            body: JSON.stringify({ url })
        });

        const data = await response.json();

        if (!response.ok) {
            render({ status: response.status, ...data });
            return;
        }

        render({
            ...data,
            downloadUrl: `${window.location.origin}${data.filePath}`
        });
    } catch (error) {
        render(`Erreur reseau: ${error.message}`);
    } finally {
        submitBtn.disabled = false;
    }
});
