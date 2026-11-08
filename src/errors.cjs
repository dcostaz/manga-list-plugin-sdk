'use strict';

/**
 * A plugin's failure codes (contract §2.6). Two module instances of the SDK exist at runtime — the host's
 * and the copy beside the plugin runtime root — so nothing classifies a `PluginError` with `instanceof`:
 * the global-registry brand and `code` are the test, on both sides.
 */

const PLUGIN_ERROR_BRAND = Symbol.for('manga-list.PluginError');

/** The plugin's closed set: a per-entry `error.code` or a thrown `PluginError.code`. */
const PLUGIN_ERROR_CODES = Object.freeze([
    'not_found',
    'credential_rejected',
    'rate_limited',
    'offline',
    'source_error',
]);

/** Thrown by the facade when the host sent what the contract forbids — a host defect, named as such. */
const HOST_CONTRACT_VIOLATION = 'host_contract_violation';

const ALL_CODES = Object.freeze([...PLUGIN_ERROR_CODES, HOST_CONTRACT_VIOLATION]);

class PluginError extends Error {
    /**
     * @param {string} code - one of PLUGIN_ERROR_CODES or 'host_contract_violation'
     * @param {string} message
     * @param {{ status?: number, retryAfterMs?: number, cause?: unknown }} [details]
     */
    constructor(code, message, details = {}) {
        if (!ALL_CODES.includes(code)) {
            throw new TypeError(`PluginError: '${code}' is not a contract error code (${ALL_CODES.join(', ')})`);
        }
        super(message);
        this.name = 'PluginError';
        /** @type {string} */
        this.code = code;
        /** @type {number | undefined} */
        this.status = details.status;
        /** @type {number | undefined} */
        this.retryAfterMs = details.retryAfterMs;
        if (details.cause !== undefined) {
            /** @type {unknown} */
            this.cause = details.cause;
        }
        Object.defineProperty(this, PLUGIN_ERROR_BRAND, { value: true, enumerable: false });
    }

    /** @returns {{ code: string, message: string }} the per-entry `error` shape (§2.1) */
    toEntryError() {
        return { code: this.code, message: this.message };
    }
}

/**
 * @param {unknown} value
 * @returns {value is PluginError}
 */
function isPluginError(value) {
    return !!value
        && typeof value === 'object'
        && /** @type {Record<symbol, unknown>} */ (value)[PLUGIN_ERROR_BRAND] === true
        && typeof /** @type {{ code?: unknown }} */ (value).code === 'string';
}

/**
 * Normalize anything thrown inside a binding into a contract-shaped error, never leaking a credential.
 * A `PluginError` passes through; anything else becomes `source_error` with its message.
 * @param {unknown} error
 * @returns {PluginError}
 */
function toPluginError(error) {
    if (isPluginError(error)) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new PluginError('source_error', message || 'source error', { cause: error });
}

module.exports = {
    PLUGIN_ERROR_BRAND,
    PLUGIN_ERROR_CODES,
    HOST_CONTRACT_VIOLATION,
    PluginError,
    isPluginError,
    toPluginError,
};
