let bandwidthChartInstance = null;
let gaugeChartInstance = null;

function buildChartColors() {
    return {
        grid: "rgba(0, 0, 0, 0.08)",
        text: "rgba(68, 68, 68, 0.9)",
        primary: "#3c8dbc",
        primaryFill: "rgba(60, 141, 188, 0.15)",
        secondary: "#f39c12"
    };
}

function createBandwidthChart(canvas, labels, values) {
    if (!window.Chart || !canvas) {
        return null;
    }

    const colors = buildChartColors();
    const context = canvas.getContext("2d");

    if (bandwidthChartInstance) {
        bandwidthChartInstance.destroy();
    }

    bandwidthChartInstance = new window.Chart(context, {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: "Debit estime (Mbps)",
                data: values,
                borderColor: colors.primary,
                backgroundColor: colors.primaryFill,
                fill: true,
                tension: 0.35,
                pointRadius: 3,
                pointHoverRadius: 5,
                pointBackgroundColor: colors.primary
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: colors.text }
                }
            },
            scales: {
                x: {
                    ticks: { color: colors.text },
                    grid: { color: colors.grid }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: colors.text },
                    grid: { color: colors.grid }
                }
            }
        }
    });

    return bandwidthChartInstance;
}

function createGaugeChart(canvas, currentValue, maxValue) {
    if (!window.Chart || !canvas) {
        return null;
    }

    const colors = buildChartColors();

    if (gaugeChartInstance) {
        gaugeChartInstance.destroy();
    }

    gaugeChartInstance = new window.Chart(canvas.getContext("2d"), {
        type: "doughnut",
        data: {
            labels: ["Courant", "Reste"],
            datasets: [{
                data: [Math.min(currentValue, maxValue), Math.max(0, maxValue - currentValue)],
                backgroundColor: [colors.secondary, "rgba(148, 163, 184, 0.14)"],
                borderWidth: 0,
                cutout: "72%"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            rotation: -90,
            circumference: 180,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false }
            }
        }
    });

    return gaugeChartInstance;
}

async function fetchSegmentStats() {
    try {
        const response = await fetch('/api/admin/segments');
        const data = await response.json();

        document.getElementById('totalSegments').textContent = data.totalSegments;
        document.getElementById('corruptedSegments').textContent = data.corruptedSegments;
        document.getElementById('retryAttempts').textContent = data.retryAttempts;
    } catch (error) {
        console.error('Failed to fetch segment stats:', error);
    }
}

window.createBandwidthChart = createBandwidthChart;
window.createGaugeChart = createGaugeChart;

// Call this function periodically or on page load
fetchSegmentStats();