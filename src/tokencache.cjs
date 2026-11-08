'use strict';

/**
 * The token cache (standardization plan Phase 1.4): in memory, per WrapperClass instance, keyed by the
 * call's `identity` (the slot presented) and the token's name. Never written to `context.cache`: a token
 * is the plugin's own operational state, never stored by the host (contract §2 `credential` row).
 *
 * A set is usable while none of its tokens has expired; an expired set is handed to the next exchange as
 * `previous`, so a refresh token can be used to mint a new access token.
 */

/** @typedef {{ value: string, expiresAt?: number | null }} Token */
/** @typedef {Record<string, Token>} TokenSet */

class TokenCache {
    /** @param {{ now?: () => number }} [options] */
    constructor(options = {}) {
        this._now = options.now || Date.now;
        /** @type {Map<string, TokenSet>} */
        this._sets = new Map();
        /** @type {Map<string, Promise<TokenSet>>} */
        this._pending = new Map();
    }

    /**
     * @param {string} identity
     * @returns {TokenSet | null} the set while every token is unexpired
     */
    getUsable(identity) {
        const set = this._sets.get(identity);
        if (!set) {
            return null;
        }
        const now = this._now();
        for (const token of Object.values(set)) {
            if (typeof token.expiresAt === 'number' && token.expiresAt <= now) {
                return null;
            }
        }
        return set;
    }

    /**
     * @param {string} identity
     * @returns {TokenSet | null} whatever is held, expired or not — the exchange's `previous`
     */
    getAny(identity) {
        return this._sets.get(identity) || null;
    }

    /**
     * @param {string} identity
     * @param {TokenSet} set
     */
    set(identity, set) {
        this._sets.set(identity, set);
    }

    /** @param {string} identity */
    invalidate(identity) {
        this._sets.delete(identity);
    }

    /**
     * One exchange in flight per identity: concurrent calls for the same slot share it.
     * @param {string} identity
     * @param {() => Promise<TokenSet>} exchange
     * @returns {Promise<TokenSet>}
     */
    async singleFlight(identity, exchange) {
        const inFlight = this._pending.get(identity);
        if (inFlight) {
            return inFlight;
        }
        const promise = (async () => {
            try {
                const set = await exchange();
                this._sets.set(identity, set);
                return set;
            } finally {
                this._pending.delete(identity);
            }
        })();
        this._pending.set(identity, promise);
        return promise;
    }
}

module.exports = { TokenCache };
