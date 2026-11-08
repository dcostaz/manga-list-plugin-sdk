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
 *   delete(key: string): Promise<void>
 * }} ScopedCache
 */

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
            };
        },
    };
}

module.exports = { createScopedCache, scopedKey };
