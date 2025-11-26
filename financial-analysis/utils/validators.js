const { access } = require("fs/promises");
const path = require("path");

/**
 * Ensures the supplied statement type is supported by the pipeline.
 *
 * @throws {Error} When the statement type is invalid.
 */
function validateStatementType(statementType) {
    if (statementType !== "bank" && statementType !== "crypto") {
        throw new Error("Error: Statement type must be 'bank' or 'crypto'");
    }
}

/**
 * Verifies that a file exists before attempting to process it.
 *
 * @returns The absolute path to the validated file.
 * @throws {Error} When the file cannot be accessed.
 */
async function assertFileExists(filePath) {
    try {
        const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(process.cwd(), filePath);
        await access(absolutePath);
        return absolutePath;
    } catch {
        throw new Error(`Error: Statement file not found: ${filePath}`);
    }
}

/**
 * Reads a required environment variable and throws a descriptive error if the
 * variable is missing.
 *
 * @param {string} key Environment variable name.
 */
function requireEnv(key) {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Error: Missing required environment variable ${key}`);
    }
    return value;
}

module.exports = {
    validateStatementType,
    assertFileExists,
    requireEnv,
};


