/**
 * BULLETPROOF Logger - Will NEVER crash your server
 * 
 * This logger is designed to be completely fail-safe:
 * - Console logging ALWAYS works
 * - File logging is optional and fails gracefully
 * - ANY error in file logging is silently ignored
 * - Server continues running even if file logging completely fails
 */
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

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

// Start with console transport only - this ALWAYS works
const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  })
];

// Try to add file logging - but if ANYTHING fails, just use console
let fileTransportAdded = false;
if (process.env.ENABLE_FILE_LOG === 'true') {
  try {
    const path = require('path');
    const fs = require('fs');
    const logsDir = path.join(process.cwd(), 'logs');
    
    // Try to ensure logs directory exists
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true, mode: 0o755 });
      }
    } catch (mkdirErr) {
      // Can't create directory - skip file logging silently
      // Console logging will continue to work
    }
    
    // Try to create file transport
    try {
      const fileTransport = new DailyRotateFile({
        filename: path.join(logsDir, 'app-%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        createSymlink: false,
        handleExceptions: false,
        handleRejections: false
      });
      
      // CRITICAL: Add error handler that SILENTLY ignores ALL errors
      fileTransport.on('error', () => {
        // Do NOTHING - silently ignore all file transport errors
        // This prevents the error from crashing the app
      });
      
      // Wrap the write method to catch any synchronous errors
      const originalWrite = fileTransport.write;
      if (originalWrite) {
        fileTransport.write = function(chunk, encoding, callback) {
          try {
            return originalWrite.call(this, chunk, encoding, (err) => {
              // Silently ignore all errors
              if (callback) callback(null);
            });
          } catch (err) {
            // Silently ignore all errors
            if (callback) callback(null);
          }
        };
      }
      
      transports.push(fileTransport);
      fileTransportAdded = true;
    } catch (transportErr) {
      // Transport creation failed - silently continue with console only
    }
  } catch (err) {
    // ANY error in file logging setup - silently continue with console only
  }
}

// Create logger with console transport (always works)
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    logFormat
  ),
  transports,
  exitOnError: false // CRITICAL: Never exit on error
});

// CRITICAL: Catch ANY logger errors and prevent them from crashing the app
logger.on('error', () => {
  // Silently ignore - never crash
});

// Wrap all logger methods to catch any errors
const originalMethods = {
  error: logger.error.bind(logger),
  warn: logger.warn.bind(logger),
  info: logger.info.bind(logger),
  debug: logger.debug.bind(logger),
  verbose: logger.verbose.bind(logger)
};

// Wrap each method to catch errors
Object.keys(originalMethods).forEach(method => {
  logger[method] = function(...args) {
    try {
      return originalMethods[method](...args);
    } catch (err) {
      // If logger itself fails, fall back to console
      console[method === 'verbose' ? 'log' : method](...args);
    }
  };
});

module.exports = logger;
