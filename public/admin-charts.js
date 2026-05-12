let bandwidthChartInstance = null;
let gaugeChartInstance = null;

function buildChartColors() {
    return {
        grid: "rgba(148, 163, 184, 0.18)",
        text: "rgba(226, 232, 240, 0.95)",
        primary: "rgba(34, 211, 238, 1)",
        primaryFill: "rgba(34, 211, 238, 0.18)",
        secondary: "rgba(168, 85, 247, 1)"
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

window.createBandwidthChart = createBandwidthChart;
window.createGaugeChart = createGaugeChart;