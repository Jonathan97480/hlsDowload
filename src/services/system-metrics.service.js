const os = require("os");

let previousCpuSample = readCpuSample();

function readCpuSample() {
    const cpus = os.cpus() || [];

    return cpus.reduce((accumulator, cpu) => {
        const times = cpu.times || {};

        return {
            idle: accumulator.idle + (times.idle || 0),
            total: accumulator.total
                + (times.user || 0)
                + (times.nice || 0)
                + (times.sys || 0)
                + (times.irq || 0)
                + (times.idle || 0)
        };
    }, { idle: 0, total: 0 });
}

function clampPercent(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(value)));
}

function getCpuPercent() {
    const currentSample = readCpuSample();
    const idleDelta = currentSample.idle - previousCpuSample.idle;
    const totalDelta = currentSample.total - previousCpuSample.total;

    previousCpuSample = currentSample;

    if (totalDelta <= 0) {
        return 0;
    }

    return clampPercent((1 - (idleDelta / totalDelta)) * 100);
}

function getMemorySnapshot() {
    const totalMemory = os.totalmem() || 0;
    const freeMemory = os.freemem() || 0;
    const usedMemory = Math.max(0, totalMemory - freeMemory);

    return {
        memoryPercent: totalMemory > 0 ? clampPercent((usedMemory / totalMemory) * 100) : 0,
        usedMemoryMb: Number((usedMemory / 1024 / 1024).toFixed(1)),
        totalMemoryMb: Number((totalMemory / 1024 / 1024).toFixed(1)),
        processMemoryMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1))
    };
}

function getSystemMetrics() {
    return {
        cpuPercent: getCpuPercent(),
        ...getMemorySnapshot()
    };
}

module.exports = {
    getSystemMetrics
};