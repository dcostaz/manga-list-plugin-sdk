'use strict';

/**
 * The cache wrapper over the host's `context.cache` (standardization plan Phase 1.6): content is keyed by
 * the plugin and the call's `scope` — the acting user for a user-side offer (even when the call rides the
 * shared system credential), `system` for a system-side one — so a user's content never sits under a key
 * that does not name that user (concepts, Caching). A token never goes here (the token cache does).
 *
 * The host's adapter may be null (caching disabled): every read is then a miss and every write a no-op,
 * never an error.
 */

/**
 * @typedef {{
 *   getValue(key: string, options?: object): Promise<unknown>,
 *   setValue(key: string, value: unknown, ttlSeconds?: number, options?: object): Promise<void>,
 *   deleteValue?(key: string, options?: object): Promise<void>
 * }} HostCacheAdapter
 */

/**
 * @typedef {{
 *   get(key: string): Promise<unknown>,
 *   set(key: string, value: unknown, ttlSeconds?: number): Promise<void>,
 *   delete(key: string): Promise<void>,
 *   readThrough(key: string, options: { fresh?: boolean, ttlSeconds?: number }, fetch: () => Promise<unknown>): Promise<CachedRead>
 * }} ScopedCache
 */

/**
 * A read through the cache (contract 4.3.0, A31): the value, whether it came from the cache, and when it was fetched
 * from the source (null for a value cached before reads recorded it).
 * @typedef {{ value: unknown, cached: boolean, fetchedAt: string | null }} CachedRead
 */

/** Marks what `readThrough` stores, so a value cached before it is told apart. */
const READ_THROUGH = 'manga-list.readThrough';

/**
 * @param {string} scope
 * @param {string} key
 * @returns {string}
 */
function scopedKey(scope, key) {
    if (typeof scope !== 'string' || !scope) {
        throw new TypeError('cache: a call has no scope (the host passes callContext.scope on every call)');
    }
    if (typeof key !== 'string' || !key) {
        throw new TypeError('cache: key must be a non-empty string');
    }
    return `scope:${scope}:${key}`;
}

/**
 * @param {HostCacheAdapter | null | undefined} adapter
 * @returns {{ bind(scope: string): ScopedCache }}
 */
function createScopedCache(adapter) {
    const usable = !!adapter && typeof adapter.getValue === 'function' && typeof adapter.setValue === 'function';
    return {
        bind(scope) {
            return {
                async get(key) {
                    const full = scopedKey(scope, key);
                    if (!usable || !adapter) {
                        return null;
                    }
                    const value = await adapter.getValue(full);
                    return value === undefined ? null : value;
                },
                async set(key, value, ttlSeconds) {
                    const full = scopedKey(scope, key);
                    if (!usable || !adapter) {
                        return;
                    }
                    await adapter.setValue(full, value, ttlSeconds);
                },
                async delete(key) {
                    const full = scopedKey(scope, key);
                    if (!usable || !adapter || typeof adapter.deleteValue !== 'function') {
                        return;
                    }
                    await adapter.deleteValue(full);
                },
                /**
                 * Read a source through the cache (A31): the cached value unless `fresh`, else the source's own answer,
                 * stored with the time it was fetched. Every reader of a key reads it this way.
                 * @param {string} key
                 * @param {{ fresh?: boolean, ttlSeconds?: number }} options
                 * @param {() => Promise<unknown>} fetch - the source's own answer
                 * @returns {Promise<CachedRead>}
                 */
                async readThrough(key, options, fetch) {
                    if (!(options && options.fresh === true)) {
                        const hit = await this.get(key);
                        if (hit !== null && hit !== undefined) {
                            const stored = /** @type {Record<string, unknown>} */ (hit);
                            if (typeof hit === 'object' && stored[READ_THROUGH] === 1) {
                                return { value: stored.value, cached: true, fetchedAt: typeof stored.fetchedAt === 'string' ? stored.fetchedAt : null };
                            }
                            return { value: hit, cached: true, fetchedAt: null };
                        }
                    }
                    const value = await fetch();
                    const fetchedAt = new Date().toISOString();
                    await this.set(key, { [READ_THROUGH]: 1, value, fetchedAt }, options ? options.ttlSeconds : undefined);
                    return { value, cached: false, fetchedAt };
                },
            };
        },
    };
}

module.exports = { createScopedCache, scopedKey };
