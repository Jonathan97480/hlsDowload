const fs = require("fs");
const path = require("path");
const util = require("util");

const LOGS_DIR = path.resolve(__dirname, "../../logs");
const SERVER_LOG_PATH = path.join(LOGS_DIR, "server.log");
const SERVER_ERROR_LOG_PATH = path.join(LOGS_DIR, "server-error.log");

let initialized = false;
let stdoutLog = null;
let stderrLog = null;
let originalConsole = null;

function ensureLogsDir() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function timestamp() {
    return new Date().toISOString();
}

function formatArgs(args) {
    return args.map((value) => {
        if (typeof value === "string") {
            return value;
        }

        return util.inspect(value, {
            depth: 5,
            breakLength: Infinity,
            colors: false
        });
    }).join(" ");
}

function writeLine(stream, level, message) {
    if (!stream || typeof stream.write !== "function") {
        return;
    }

    stream.write(`[${timestamp()}] [${level}] ${message}\n`);
}

function patchConsoleMethod(methodName, level, stream, mirror) {
    return (...args) => {
        const message = formatArgs(args);
        writeLine(stream, level, message);
        mirror(...args);
    };
}

function attachProcessHandlers() {
    process.on("uncaughtException", (error) => {
        const message = error && error.stack ? error.stack : String(error || "unknown error");
        writeLine(stderrLog, "FATAL", message);
        if (originalConsole?.error) {
            originalConsole.error(error);
        }
    });

    process.on("unhandledRejection", (reason) => {
        const message = reason && reason.stack ? reason.stack : String(reason || "unknown rejection");
        writeLine(stderrLog, "ERROR", `UnhandledRejection: ${message}`);
        if (originalConsole?.error) {
            originalConsole.error(reason);
        }
    });
}

function initLogger() {
    if (initialized) {
        return {
            serverLogPath: SERVER_LOG_PATH,
            errorLogPath: SERVER_ERROR_LOG_PATH
        };
    }

    ensureLogsDir();
    stdoutLog = fs.createWriteStream(SERVER_LOG_PATH, { flags: "a" });
    stderrLog = fs.createWriteStream(SERVER_ERROR_LOG_PATH, { flags: "a" });
    originalConsole = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };

    console.log = patchConsoleMethod("log", "INFO", stdoutLog, originalConsole.log);
    console.info = patchConsoleMethod("info", "INFO", stdoutLog, originalConsole.info);
    console.warn = patchConsoleMethod("warn", "WARN", stderrLog, originalConsole.warn);
    console.error = patchConsoleMethod("error", "ERROR", stderrLog, originalConsole.error);

    attachProcessHandlers();
    initialized = true;

    console.log(`[logger] Sortie standard: ${SERVER_LOG_PATH}`);
    console.log(`[logger] Sortie erreur: ${SERVER_ERROR_LOG_PATH}`);

    return {
        serverLogPath: SERVER_LOG_PATH,
        errorLogPath: SERVER_ERROR_LOG_PATH
    };
}

module.exports = {
    initLogger
};
