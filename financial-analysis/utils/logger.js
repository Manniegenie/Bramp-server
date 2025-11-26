/**
 * Minimal structured logger with timestamped output.
 *
 * Using console-based logging keeps the MVP lightweight while providing clear
 * visibility into pipeline progress. Replace with a dedicated logger if file
 * persistence or log levels are required.
 */
class Logger {
    formatMessage(level, message) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}`;
    }

    info(message) {
        console.log(this.formatMessage("INFO", message));
    }

    warn(message) {
        console.warn(this.formatMessage("WARN", message));
    }

    error(message, error) {
        console.error(this.formatMessage("ERROR", message), error ?? "");
    }

    success(message) {
        console.log(this.formatMessage("SUCCESS", message));
    }
}

module.exports = { logger: new Logger() };


