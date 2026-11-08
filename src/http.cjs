'use strict';

/**
 * The SDK's HTTP discipline (standardization plan Phase 1.3), built per WrapperClass instance over the
 * axios instance the host injects as `context.http`, and bound per call to that call's credential,
 * identity, scope and signal. It reads exactly Decision 5's SDK-read settings:
 *
 *   connection.timeout.{connect,request,search}          per-request timeout; connect as the socket bound
 *   connection.pool.{keepAlive,maxSockets,maxFreeSockets} the instance's keep-alive agents
 *   retry.{enabled,maxAttempts}, retry.backoff.{type,initialDelay,maxDelay,multiplier}
 *   rateLimit.global.{enabled,maxConcurrent,maxPerSecond,maxPerMinute,queueSize}
 *   rateLimit.perEndpoint.{enabled,defaultDelay}, api.endpoints.<name>.throttle
 *   resilience.circuitBreaker.{enabled,failureThreshold,failureWindow,openDuration}
 *
 * Failures come out as `PluginError`s with the contract's codes (§2.6): 401/403 → credential_rejected,
 * 404 → not_found, 429 → rate_limited (after honouring Retry-After), 5xx → source_error, transport and
 * abort → offline. `authed(fn)` is the one 401 shape: re-exchange once under the same credential, replay
 * once. Nothing here is module-level: every piece of state hangs off the instance.
 */

const { PluginError, isPluginError } = require('./errors.cjs');
const { TokenCache } = require('./tokencache.cjs');

/** @typedef {import('./tokencache.cjs').TokenSet} TokenSet */

/**
 * @typedef {{
 *   exchange(credential: unknown, ctx: { http: CallHttp, settings: Record<string, unknown>, previous: TokenSet | null, reason: 'initial' | 'expired' | 'rejected' }): Promise<{ tokens: TokenSet }>,
 *   apply(tokens: TokenSet, config: RequestConfig): RequestConfig,
 *   isAuthFailure?(error: unknown): boolean
 * }} AuthStrategy
 */

/**
 * @typedef {Record<string, any> & {
 *   url?: string, method?: string, endpoint?: string, timeoutKind?: 'request' | 'search',
 *   headers?: Record<string, string>, signal?: AbortSignal
 * }} RequestConfig
 */

/**
 * @typedef {{
 *   request(config: RequestConfig): Promise<any>,
 *   get(url: string, config?: RequestConfig): Promise<any>,
 *   post(url: string, data?: unknown, config?: RequestConfig): Promise<any>,
 *   authed<T>(fn: (tokens: TokenSet) => Promise<T>): Promise<T>,
 *   authedRequest(config: RequestConfig): Promise<any>,
 *   readonly signal: AbortSignal | null
 * }} CallHttp
 */

/** @typedef {{ credential: unknown, identity: string, scope: string, signal: AbortSignal | null }} CallBinding */

const RETRYABLE_NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK']);
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * @param {Record<string, unknown>} settings
 */
function settingsReader(settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    return {
        /** @param {string} key @param {number} fallback */
        num(key, fallback) {
            const v = s[key];
            const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
            return Number.isFinite(n) ? n : fallback;
        },
        /** @param {string} key @param {boolean} fallback */
        bool(key, fallback) {
            const v = s[key];
            if (typeof v === 'boolean') return v;
            if (v === 'true') return true;
            if (v === 'false') return false;
            return fallback;
        },
        /** @param {string} key @param {string} fallback */
        str(key, fallback) {
            const v = s[key];
            return typeof v === 'string' && v ? v : fallback;
        },
        /** @param {string} key */
        has(key) {
            return Object.prototype.hasOwnProperty.call(s, key);
        },
    };
}

/**
 * Abortable sleep.
 * @param {number} ms
 * @param {AbortSignal | null} signal
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    if (ms <= 0) {
        return signal && signal.aborted ? Promise.reject(abortedError()) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(abortedError());
            return;
        }
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(abortedError());
        }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

function abortedError() {
    return new PluginError('offline', 'the call was aborted (its ceiling passed or it was cancelled)');
}

/**
 * Retry-After: seconds, or an HTTP date.
 * @param {unknown} value
 * @param {number} now
 * @returns {number | null} milliseconds
 */
function parseRetryAfter(value, now) {
    if (value === undefined || value === null || value === '') return null;
    const raw = Array.isArray(value) ? value[0] : value;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(String(raw));
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * @param {any} error - an axios error, or anything thrown by the transport
 * @param {number} now
 * @returns {{ pluginError: PluginError, retryable: boolean, retryAfterMs: number | null, countsAgainstCircuit: boolean }}
 */
function classifyTransportError(error, now) {
    if (isPluginError(error)) {
        return { pluginError: error, retryable: false, retryAfterMs: null, countsAgainstCircuit: false };
    }
    const response = error && typeof error === 'object' ? error.response : null;
    const status = response && typeof response.status === 'number' ? response.status : null;
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'ERR_CANCELED' || (error && error.name === 'CanceledError') || (error && error.name === 'AbortError')) {
        return { pluginError: abortedError(), retryable: false, retryAfterMs: null, countsAgainstCircuit: false };
    }
    if (status !== null) {
        const headers = response.headers || {};
        if (status === 401 || status === 403) {
            return { pluginError: new PluginError('credential_rejected', `the source refused the credential (HTTP ${status})`, { status }), retryable: false, retryAfterMs: null, countsAgainstCircuit: false };
        }
        if (status === 404) {
            return { pluginError: new PluginError('not_found', 'not found at the source (HTTP 404)', { status }), retryable: false, retryAfterMs: null, countsAgainstCircuit: false };
        }
        if (status === 429) {
            const retryAfterMs = parseRetryAfter(headers['retry-after'] ?? headers['Retry-After'], now);
            return { pluginError: new PluginError('rate_limited', 'the source rate-limited the call (HTTP 429)', { status, retryAfterMs: retryAfterMs ?? undefined }), retryable: true, retryAfterMs, countsAgainstCircuit: false };
        }
        const retryable = RETRYABLE_STATUSES.has(status);
        return { pluginError: new PluginError('source_error', `the source answered HTTP ${status}`, { status }), retryable, retryAfterMs: null, countsAgainstCircuit: status >= 500 };
    }
    const retryable = RETRYABLE_NETWORK_CODES.has(code) || /timeout/i.test(message);
    return { pluginError: new PluginError('offline', `transport failure${code ? ` (${code})` : ''}: ${message}`, { cause: error }), retryable, retryAfterMs: null, countsAgainstCircuit: true };
}

class RateLimiter {
    /**
     * @param {ReturnType<typeof settingsReader>} read
     * @param {() => number} now
     */
    constructor(read, now) {
        this.enabled = read.bool('rateLimit.global.enabled', true);
        this.maxConcurrent = Math.max(1, read.num('rateLimit.global.maxConcurrent', 5));
        this.maxPerSecond = Math.max(0, read.num('rateLimit.global.maxPerSecond', 0));
        this.maxPerMinute = Math.max(0, read.num('rateLimit.global.maxPerMinute', 0));
        this.queueSize = Math.max(0, read.num('rateLimit.global.queueSize', 50));
        this._now = now;
        this.active = 0;
        this.waiting = 0;
        /** @type {number[]} */
        this.starts = [];
        /** @type {Set<() => void>} */
        this.wakers = new Set();
    }

    /** @returns {number | null} 0 when a request may start now; ms until a window frees; null when only concurrency blocks */
    _wait() {
        const now = this._now();
        this.starts = this.starts.filter((t) => now - t < 60000);
        if (this.active >= this.maxConcurrent) return null;
        if (this.maxPerSecond > 0) {
            const inSecond = this.starts.filter((t) => now - t < 1000);
            if (inSecond.length >= this.maxPerSecond) return 1000 - (now - inSecond[0]);
        }
        if (this.maxPerMinute > 0 && this.starts.length >= this.maxPerMinute) {
            return 60000 - (now - this.starts[0]);
        }
        return 0;
    }

    /**
     * @param {AbortSignal | null} signal
     * @returns {Promise<() => void>} release
     */
    async acquire(signal) {
        if (!this.enabled) return () => {};
        if (this._wait() !== 0 && this.waiting >= this.queueSize) {
            throw new PluginError('rate_limited', `the plugin's request queue is full (${this.queueSize})`);
        }
        this.waiting += 1;
        try {
            for (;;) {
                const wait = this._wait();
                if (wait === 0) break;
                await new Promise((resolve, reject) => {
                    /** @type {ReturnType<typeof setTimeout> | null} */
                    let timer = null;
                    const done = () => {
                        if (timer) clearTimeout(timer);
                        this.wakers.delete(done);
                        if (signal) signal.removeEventListener('abort', onAbort);
                        resolve(undefined);
                    };
                    const onAbort = () => {
                        if (timer) clearTimeout(timer);
                        this.wakers.delete(done);
                        reject(abortedError());
                    };
                    this.wakers.add(done);
                    if (wait !== null) timer = setTimeout(done, Math.max(1, wait));
                    if (signal) {
                        if (signal.aborted) { onAbort(); return; }
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                });
            }
        } finally {
            this.waiting -= 1;
        }
        this.active += 1;
        this.starts.push(this._now());
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active -= 1;
            for (const wake of [...this.wakers]) wake();
        };
    }
}

class CircuitBreaker {
    /**
     * @param {ReturnType<typeof settingsReader>} read
     * @param {() => number} now
     */
    constructor(read, now) {
        this.enabled = read.bool('resilience.circuitBreaker.enabled', false);
        this.threshold = Math.max(1, read.num('resilience.circuitBreaker.failureThreshold', 5));
        this.window = Math.max(1, read.num('resilience.circuitBreaker.failureWindow', 10000));
        this.openDuration = Math.max(1, read.num('resilience.circuitBreaker.openDuration', 30000));
        this._now = now;
        /** @type {number[]} */
        this.failures = [];
        this.openUntil = 0;
    }

    check() {
        if (this.enabled && this._now() < this.openUntil) {
            throw new PluginError('offline', 'the plugin\'s circuit is open after repeated source failures');
        }
    }

    success() {
        this.failures = [];
    }

    failure() {
        if (!this.enabled) return;
        const now = this._now();
        this.failures = this.failures.filter((t) => now - t < this.window);
        this.failures.push(now);
        if (this.failures.length >= this.threshold) {
            this.openUntil = now + this.openDuration;
            this.failures = [];
        }
    }
}

/**
 * @param {{
 *   axios: any,
 *   settings: Record<string, unknown>,
 *   auth?: AuthStrategy | null,
 *   now?: () => number,
 * }} options
 */
function createHttpRuntime(options) {
    const read = settingsReader(options.settings);
    const now = options.now || Date.now;
    const axios = options.axios || null;
    const auth = options.auth || null;
    const limiter = new RateLimiter(read, now);
    const circuit = new CircuitBreaker(read, now);
    const tokens = new TokenCache({ now });
    /** @type {Map<string, number>} */
    const nextSlot = new Map();
    /** @type {Array<(response: any) => void>} */
    const normalizers = [];
    /** @type {{ http?: any, https?: any } | null} */
    let agents = null;

    const retryEnabled = read.bool('retry.enabled', true);
    const maxAttempts = retryEnabled ? Math.max(1, Math.floor(read.num('retry.maxAttempts', 3))) : 1;
    const backoffType = read.str('retry.backoff.type', 'exponential');
    const initialDelay = Math.max(0, read.num('retry.backoff.initialDelay', 1000));
    const maxDelay = Math.max(0, read.num('retry.backoff.maxDelay', 10000));
    const multiplier = Math.max(1, read.num('retry.backoff.multiplier', 2));
    const perEndpointEnabled = read.bool('rateLimit.perEndpoint.enabled', false);
    const defaultDelay = Math.max(0, read.num('rateLimit.perEndpoint.defaultDelay', 0));

    /** @param {number} attempt - 1-based count of failed attempts so far */
    function backoff(attempt) {
        let delay = initialDelay;
        if (backoffType === 'exponential') delay = initialDelay * Math.pow(multiplier, attempt - 1);
        else if (backoffType === 'linear') delay = initialDelay * attempt;
        return Math.min(maxDelay, delay);
    }

    /** @param {string | undefined} endpoint */
    function throttleDelay(endpoint) {
        if (endpoint && read.has(`api.endpoints.${endpoint}.throttle`)) {
            return Math.max(0, read.num(`api.endpoints.${endpoint}.throttle`, 0));
        }
        return perEndpointEnabled ? defaultDelay : 0;
    }

    function poolAgents() {
        if (agents) return agents;
        agents = {};
        try {
            const keepAlive = read.bool('connection.pool.keepAlive', true);
            const agentOptions = {
                keepAlive,
                maxSockets: Math.max(1, read.num('connection.pool.maxSockets', 10)),
                maxFreeSockets: Math.max(0, read.num('connection.pool.maxFreeSockets', 5)),
                timeout: Math.max(1, read.num('connection.timeout.connect', 5000)),
            };
            agents.http = new (require('http').Agent)(agentOptions);
            agents.https = new (require('https').Agent)(agentOptions);
        } catch {
            agents = {};
        }
        return agents;
    }

    /**
     * @param {RequestConfig} config
     * @param {AbortSignal | null} signal
     */
    async function request(config, signal) {
        if (!axios || typeof axios.request !== 'function') {
            throw new PluginError('offline', 'no HTTP client was injected by the host (context.http)');
        }
        const { endpoint, timeoutKind, ...rest } = config || {};
        const timeout = Math.max(1, read.num(`connection.timeout.${timeoutKind === 'search' ? 'search' : 'request'}`, 30000));
        const pool = poolAgents();

        for (let attempt = 1; ; attempt += 1) {
            circuit.check();
            const release = await limiter.acquire(signal);
            try {
                const delay = throttleDelay(endpoint);
                if (delay > 0) {
                    const key = endpoint || '__default';
                    const at = Math.max(now(), nextSlot.get(key) || 0);
                    nextSlot.set(key, at + delay);
                    await sleep(at - now(), signal);
                }
                if (signal && signal.aborted) throw abortedError();
                /** @type {RequestConfig} */
                const finalConfig = { timeout, ...rest };
                if (signal) finalConfig.signal = signal;
                if (pool.http && finalConfig.httpAgent === undefined) finalConfig.httpAgent = pool.http;
                if (pool.https && finalConfig.httpsAgent === undefined) finalConfig.httpsAgent = pool.https;
                const response = await axios.request(finalConfig);
                for (const normalize of normalizers) normalize(response);
                circuit.success();
                return response;
            } catch (error) {
                if (signal && signal.aborted) throw abortedError();
                if (isPluginError(error)) throw error;
                if (error && /** @type {any} */ (error).response) {
                    for (const normalize of normalizers) normalize(/** @type {any} */ (error).response);
                }
                const classified = classifyTransportError(error, now());
                if (classified.countsAgainstCircuit) circuit.failure();
                if (!classified.retryable || attempt >= maxAttempts) throw classified.pluginError;
                await sleep(classified.retryAfterMs ?? backoff(attempt), signal);
            } finally {
                release();
            }
        }
    }

    return {
        /**
         * A client registers a response normalizer once, at construction (e.g. a Cloudflare HTML body →
         * a typed `PluginError`). Normalizers inspect a response and may throw; they never replay.
         * @param {(response: any) => void} fn
         */
        addNormalizer(fn) {
            if (typeof fn !== 'function') throw new TypeError('addNormalizer: a function is required');
            normalizers.push(fn);
        },

        /** Exposed for tests and the facade's default testCredentials. */
        tokens,

        /**
         * @param {CallBinding} binding
         * @returns {CallHttp}
         */
        bind(binding) {
            const signal = binding.signal || null;
            /** @type {CallHttp} */
            const call = {
                signal,
                request: (config) => request(config, signal),
                get: (url, config = {}) => request({ ...config, method: 'get', url }, signal),
                post: (url, data, config = {}) => request({ ...config, method: 'post', url, data }, signal),
                async authed(fn) {
                    if (!auth) {
                        throw new PluginError('source_error', 'authed(): this plugin declares no auth strategy');
                    }
                    if (binding.credential === null || binding.credential === undefined) {
                        throw new PluginError('credential_rejected', 'no credential was presented for an offer that needs one');
                    }
                    const identity = binding.identity;
                    /** @param {'initial' | 'expired' | 'rejected'} reason */
                    const exchange = (reason) => tokens.singleFlight(identity, async () => {
                        const previous = tokens.getAny(identity);
                        const out = await auth.exchange(binding.credential, { http: call, settings: options.settings || {}, previous, reason });
                        if (!out || typeof out !== 'object' || !out.tokens || typeof out.tokens !== 'object') {
                            throw new PluginError('source_error', 'auth.exchange() returned no tokens');
                        }
                        return out.tokens;
                    });
                    const isAuthFailure = typeof auth.isAuthFailure === 'function'
                        ? auth.isAuthFailure
                        : (/** @type {unknown} */ error) => isPluginError(error) && error.status === 401;

                    let set = tokens.getUsable(identity);
                    if (!set) set = await exchange(tokens.getAny(identity) ? 'expired' : 'initial');
                    try {
                        return await fn(set);
                    } catch (error) {
                        if (!isAuthFailure(error)) throw error;
                        // Re-exchange once under the same credential, then replay once. A concurrent call
                        // that already re-exchanged left a newer set: use it rather than exchanging again.
                        // The rejected set stays as `previous`, so a refresh token can still be tried.
                        const current = tokens.getUsable(identity);
                        const fresh = current && current !== set ? current : await exchange('rejected');
                        return fn(fresh);
                    }
                },
                authedRequest(config) {
                    return call.authed((set) => request(/** @type {AuthStrategy} */ (auth).apply(set, { ...config }), signal));
                },
            };
            return call;
        },
    };
}

module.exports = {
    createHttpRuntime,
    classifyTransportError,
    parseRetryAfter,
    sleep,
};
