'use strict';

const { toPluginError } = require('./errors.cjs');

/**
 * Array in, array out, per-entry failure (contract §2.1): one result per input entry, in order; a failure
 * of one entry never throws for the batch.
 *
 * @template TEntry, TResult
 * @param {TEntry[]} entries
 * @param {(entry: TEntry) => Promise<TResult>} fn - returns the entry's success payload (merged into the result)
 * @param {{ idOf?: (entry: TEntry) => string, concurrency?: number }} [options]
 * @returns {Promise<Array<{ pluginEntryId: string, success: boolean, error?: { code: string, message: string } } & Partial<TResult>>>}
 */
async function perEntry(entries, fn, options = {}) {
    if (!Array.isArray(entries)) {
        throw new TypeError('perEntry: entries must be an array');
    }
    const idOf = options.idOf || defaultIdOf;
    const concurrency = Math.max(1, Math.floor(options.concurrency || 1));
    /** @type {any[]} */
    const results = new Array(entries.length);
    let next = 0;

    async function worker() {
        while (next < entries.length) {
            const index = next;
            next += 1;
            const entry = entries[index];
            const pluginEntryId = idOf(entry);
            try {
                const payload = await fn(entry);
                results[index] = { ...(payload && typeof payload === 'object' ? payload : {}), pluginEntryId, success: true };
            } catch (error) {
                results[index] = { pluginEntryId, success: false, error: toPluginError(error).toEntryError() };
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker));
    return results;
}

/**
 * @param {unknown} entry
 * @returns {string}
 */
function defaultIdOf(entry) {
    if (typeof entry === 'string') {
        return entry;
    }
    if (entry && typeof entry === 'object' && typeof (/** @type {{ pluginEntryId?: unknown }} */ (entry)).pluginEntryId === 'string') {
        return /** @type {{ pluginEntryId: string }} */ (entry).pluginEntryId;
    }
    throw new TypeError('perEntry: an entry has no pluginEntryId (pass options.idOf)');
}

/**
 * The `not_found` result arm (contract §2.6): an entry the source does not know is a report, not a
 * failure of the call. On an array offer it is the entry's `success: false` with `error.code: 'not_found'`.
 * @param {string} pluginEntryId
 * @param {string} [message]
 * @returns {{ pluginEntryId: string, success: false, error: { code: 'not_found', message: string } }}
 */
function notFoundEntry(pluginEntryId, message) {
    return { pluginEntryId, success: false, error: { code: 'not_found', message: message || 'not found at the source' } };
}

/**
 * §2.4's disclosure on a candidate answered from the plugin's own cache.
 * @template {object} T
 * @param {T} candidate
 * @param {string | Date | null} [fetchedAt] - when the cached answer was fetched from the source
 * @returns {T & { cached: true, fetchedAt?: string }}
 */
function markCached(candidate, fetchedAt) {
    /** @type {any} */
    const out = { ...candidate, cached: true };
    if (fetchedAt instanceof Date) {
        out.fetchedAt = fetchedAt.toISOString();
    } else if (typeof fetchedAt === 'string' && fetchedAt) {
        out.fetchedAt = fetchedAt;
    }
    return out;
}

module.exports = {
    perEntry,
    notFoundEntry,
    markCached,
};
