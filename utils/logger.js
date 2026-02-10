const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Utility to safely stringify objects, handling circular references
function safeStringify(obj, indent = 2) {
  const cache = new Set();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (cache.has(value)) {
          return '[Circular]';
        }
        cache.add(value);
      }
      return value;
    },
    indent
  );
}

// Custom log format
const logFormat = winston.format.printf(({ timestamp, level, message, ...metadata }) => {
  let logMessage = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length) {
    logMessage += ` ${safeStringify(metadata)}`;
  }
  return logMessage;
});

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  })
];

// Add file transport only if logs dir is writable (avoids EACCES crash on server)
function isLogsDirWritable() {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const testFile = path.join(logsDir, '.write-test');
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

if (isLogsDirWritable()) {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    const fileTransport = new DailyRotateFile({
      filename: path.join(logsDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d'
    });
    fileTransport.on('error', () => { /* ignore write errors */ });
    transports.push(fileTransport);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[logger] File logging disabled:', err.code || err.message);
    }
  }
} else if (process.env.NODE_ENV !== 'test') {
  console.warn('[logger] File logging disabled: logs directory not writable');
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    logFormat
  ),
  transports,
  exitOnError: false
});

module.exports = logger;