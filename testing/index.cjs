'use strict';

/**
 * @manga-list/plugin-sdk/testing — the contract's executable form
 * (Plan-2026Q4-tracker-plugin-standardization, Phases 1.7 and 2).
 *
 * The unit under test is a loaded WrapperClass behind the contract boundary, built by defineTrackerPlugin()
 * or by hand. Two construction shapes: `harness: '4.0'` (the contract's init) and `harness: '3.x'` (what the
 * pre-4.0 wrappers expect: an HTTP client factory, and `setCredentials` before each call, the call context
 * still appended). Each case has a kind — structure, shape, behaviour, harness — and, where it encodes one,
 * the analysis finding it reproduces (docs/Analysis-2026Q4-tracker-plugin-layers.md), so a red run reads
 * against Part IV and Appendix A.
 */

const { OFFER_METHODS, HOST_READING_STATUSES } = require('../src/contract.cjs');
const { validateResult } = require('../src/validators.cjs');
const { isPluginError, HOST_CONTRACT_VIOLATION } = require('../src/errors.cjs');

/** Lifecycle and access methods a WrapperClass may carry beside its §2 operation methods. */
const LIFECYCLE_METHODS = Object.freeze(['constructor', 'initialize', 'getStatus', 'testCredentials']);

/** Array-shaped methods (§2.1) and the argument that carries their entries. */
const ARRAY_METHODS = Object.freeze(['enrich', 'pushProgress', 'subscribe', 'unsubscribe', 'summarizeEntries']);

/** Which case encodes which analysis finding. */
const RESULT_FINDINGS = Object.freeze({
    search: 'IV.search-id-and-confidence',
    pullProgress: 'F13',
    summarizeEntries: 'F5',
    getReadingList: 'A13',
});

/**
 * @typedef {{ status?: number, data?: unknown, headers?: Record<string, string> }} StubResponse
 * @typedef {(config: Record<string, any>) => StubResponse | Promise<StubResponse>} StubHandler
 * @typedef {{ credential: unknown, identity: string, scope: string, signal: AbortSignal | null }} CallContext
 * @typedef {{ id: string, kind: 'structure' | 'shape' | 'behaviour' | 'harness', finding?: string, problems: string[], threw?: boolean }} CaseFailure
 */

/**
 * An axios-shaped stub: `request(config)` answers through the handler, records every call, and throws an
 * axios-shaped error (`error.response.status`) for a status of 400 or more. `setHandler` swaps the source.
 * @param {StubHandler} [handler]
 */
function createStubAxios(handler) {
    /** @type {Array<Record<string, any>>} */
    const calls = [];
    /** @type {StubHandler} */
    let respond = handler || (() => ({ status: 200, data: {} }));
    /** @param {Record<string, any>} config */
    async function request(config) {
        calls.push(config);
        if (config.signal && config.signal.aborted) {
            const aborted = new Error('canceled');
            aborted.name = 'CanceledError';
            /** @type {any} */ (aborted).code = 'ERR_CANCELED';
            throw aborted;
        }
        const out = await respond(config);
        const status = out && typeof out.status === 'number' ? out.status : 200;
        const response = { status, data: out ? out.data : undefined, headers: (out && out.headers) || {}, config };
        if (status >= 400) {
            const error = new Error(`Request failed with status code ${status}`);
            /** @type {any} */ (error).response = response;
            /** @type {any} */ (error).isAxiosError = true;
            throw error;
        }
        return response;
    }
    /** @param {string} method */
    const verb = (method) => (/** @type {string} */ url, /** @type {any} */ a, /** @type {any} */ b) => {
        const withBody = method === 'post' || method === 'put' || method === 'patch';
        const config = withBody ? { ...(b || {}), method, url, data: a } : { ...(a || {}), method, url };
        return request(config);
    };
    return {
        calls,
        request,
        get: verb('get'),
        delete: verb('delete'),
        post: verb('post'),
        put: verb('put'),
        patch: verb('patch'),
        defaults: { headers: {} },
        interceptors: { request: { use() { return 0; }, eject() {} }, response: { use() { return 0; }, eject() {} } },
        /** @param {StubHandler} next */
        setHandler(next) {
            respond = next;
        },
        /** @returns {StubHandler} */
        getHandler() {
            return respond;
        },
    };
}

/**
 * A source that knows nothing about any plugin: every login-like POST mints a fresh token (in every field
 * name a token is commonly read from), every other call answers an empty, generically shaped payload. Used
 * by red runs against plugins that ship no source fixture; it records which tokens it minted in which phase.
 */
function createGenericSource() {
    let minted = 0;
    let phase = 'none';
    /** @type {Map<string, string>} */
    const tokenPhase = new Map();
    /** @param {Record<string, any>} config */
    function handler(config) {
        const url = String(config.url || '');
        const method = String(config.method || 'get').toLowerCase();
        if ((method === 'post' || method === 'put') && /login|token|auth|session/i.test(url)) {
            minted += 1;
            const token = `generic-token-${minted}`;
            tokenPhase.set(token, phase);
            return {
                status: 200,
                data: {
                    access_token: token, refresh_token: `generic-refresh-${minted}`, session_token: token, token, expires_in: 900,
                    status: 'success', context: { session_token: token, uid: 1 }, data: { token, session_token: token },
                },
            };
        }
        return { status: 200, data: { data: [], results: [], lists: [], entries: [], items: [], total: 0, total_hits: 0, result: 'ok' } };
    }
    return {
        handler,
        tokenPhase,
        /** @param {string} next */
        setPhase(next) { phase = next; },
    };
}

/** An in-memory host cache adapter that records each key written with the scope active at the time. */
function createStubCache() {
    /** @type {Map<string, unknown>} */
    const store = new Map();
    /** @type {Array<{ key: string, scope: string | null }>} */
    const writes = [];
    let activeScope = /** @type {string | null} */ (null);
    return {
        store,
        writes,
        /** @param {string | null} scope */
        setActiveScope(scope) { activeScope = scope; },
        /** @param {string} key */
        async getValue(key) {
            return store.has(key) ? store.get(key) : null;
        },
        /** @param {string} key @param {unknown} value */
        async setValue(key, value) {
            writes.push({ key, scope: activeScope });
            store.set(key, value);
        },
        /** @param {string} key */
        async deleteValue(key) {
            store.delete(key);
        },
    };
}

/**
 * The context the host injects at init: { utils, http, cache }.
 * @param {{ axios?: any, cache?: any }} [options]
 */
function createStubContext(options = {}) {
    return {
        utils: {
            /** @param {string} text */
            sanitizeForSearch(text) {
                return typeof text === 'string' ? text.normalize('NFKD').toLowerCase().replace(/\s+/g, ' ').trim() : '';
            },
        },
        http: options.axios || createStubAxios(),
        cache: options.cache === undefined ? createStubCache() : options.cache,
    };
}

/**
 * A callContext the host would pass (contract §2): opaque labels, no secret in them.
 * @param {{ credential?: unknown, identity?: string, scope?: string, signal?: AbortSignal | null }} [overrides]
 * @returns {CallContext}
 */
function callContext(overrides = {}) {
    return {
        credential: overrides.credential === undefined ? { token: 'stub-credential' } : overrides.credential,
        identity: overrides.identity || 'slot-label-a',
        scope: overrides.scope || 'user-label-a',
        signal: overrides.signal === undefined ? null : overrides.signal,
    };
}

/** @param {string} suffix */
function credentialFor(suffix) {
    return {
        apiKey: `key-${suffix}`, username: `user-${suffix}`, password: `pass-${suffix}`,
        client_id: `cid-${suffix}`, client_secret: `secret-${suffix}`,
    };
}

/**
 * Sample arguments per method (everything but the callContext).
 * @param {Record<string, any>} manifest
 * @returns {Record<string, any[]>}
 */
function defaultInputs(manifest) {
    const sync = manifest.syncOptions || {};
    const vocab = sync.statusVocabulary || {};
    const push = vocab.push && typeof vocab.push === 'object' ? vocab.push : vocab;
    const firstToken = Object.values(push).find((v) => typeof v === 'string') || 'reading';
    const pushAxes = sync.progressAxes && Array.isArray(sync.progressAxes.push)
        ? sync.progressAxes.push.map((/** @type {any} */ a) => (typeof a === 'string' ? a : a.axis))
        : [];
    /** @type {Record<string, number>} */
    const progress = {};
    if (pushAxes.includes('chapter')) progress.chapter = 12;
    if (pushAxes.includes('rating')) progress.rating = 8;
    return {
        search: ['a title', undefined],
        lookup: ['entry-1'],
        enrich: [['entry-1', 'entry-2']],
        searchCovers: [{ title: 'a title' }, undefined],
        downloadCover: ['cover-1'],
        pullProgress: ['entry-1'],
        pushProgress: [[{ pluginEntryId: 'entry-1', ...progress }]],
        getReadingList: [],
        subscribe: [[{ pluginEntryId: 'entry-1', status: firstToken }]],
        unsubscribe: [['entry-1']],
        queryLive: ['entry-1'],
        summarizeEntries: [['entry-1', 'entry-2']],
        listChapters: ['entry-1', undefined],
        listPages: ['entry-1', 'chapter-1'],
        downloadPage: ['entry-1', 'chapter-1', 'page-1'],
    };
}

/**
 * @param {any[]} args
 * @returns {string[] | null}
 */
function inputIdsOf(args) {
    const first = args[0];
    if (!Array.isArray(first)) return null;
    return first.map((e) => (typeof e === 'string' ? e : e.pluginEntryId));
}

/**
 * The tokens a plugin may return as a status: `pull`'s keys (4.x), or the flat table's values (3.x).
 * @param {Record<string, any>} manifest
 * @returns {Set<string> | null}
 */
function sourceTokens(manifest) {
    const vocab = manifest.syncOptions && manifest.syncOptions.statusVocabulary;
    if (!vocab || typeof vocab !== 'object') return null;
    if (vocab.pull && typeof vocab.pull === 'object') return new Set(Object.keys(vocab.pull));
    return new Set(Object.values(vocab).filter((v) => typeof v === 'string'));
}

/**
 * A settings shim for a 3.x wrapper's `apiSettings`.
 * @param {Record<string, unknown>} settings
 */
function settingsShim(settings) {
    return {
        componentName: 'ConformanceRun',
        getAll: () => ({ ...settings }),
        toLegacyFormat: () => ({ ...settings }),
        /** @param {string} key */
        getSetting: (key) => settings[key],
        /** @param {string} key */
        get: (key) => settings[key],
    };
}

/**
 * Run the contract cases against a WrapperClass.
 *
 * @param {{
 *   WrapperClass: any,
 *   manifest: Record<string, any>,
 *   descriptor?: Record<string, any> | null,
 *   harness?: '4.0' | '3.x',
 *   settings?: Record<string, unknown>,
 *   source?: StubHandler,
 *   axios?: ReturnType<typeof createStubAxios>,
 *   initOptions?: Record<string, any>,
 *   inputs?: Record<string, any[]>,
 *   credentials?: [unknown, unknown],
 *   context?: (overrides?: object) => CallContext,
 *   expect?: { readingListLength?: number },
 * }} options
 * @returns {Promise<{ passed: string[], failed: CaseFailure[] }>}
 */
async function runConformance(options) {
    const { WrapperClass, manifest } = options;
    const harness = options.harness || '4.0';
    const inputs = { ...defaultInputs(manifest), ...(options.inputs || {}) };
    const generic = options.source || options.axios ? null : createGenericSource();
    const axios = options.axios || createStubAxios(options.source || /** @type {StubHandler} */ (/** @type {any} */ (generic).handler));
    const cache = createStubCache();
    const [credA, credB] = options.credentials || [credentialFor('A'), credentialFor('B')];
    /** @param {object} [overrides] */
    const custom = options.context;
    /** @type {(overrides?: object) => CallContext} */
    const makeContext = custom
        ? (overrides = {}) => ({ ...custom(overrides), ...overrides })
        : (overrides = {}) => callContext({ credential: credA, ...overrides });
    /** @type {string[]} */
    const passed = [];
    /** @type {CaseFailure[]} */
    const failed = [];

    /**
     * @param {string} id
     * @param {CaseFailure['kind']} kind
     * @param {string | undefined} finding
     * @param {() => Promise<string[]> | string[]} run
     */
    async function check(id, kind, finding, run) {
        try {
            const problems = await run();
            if (problems.length) failed.push({ id, kind, ...(finding ? { finding } : {}), problems });
            else passed.push(id);
        } catch (error) {
            failed.push({ id, kind, ...(finding ? { finding } : {}), threw: true, problems: [`threw: ${error instanceof Error ? error.message : String(error)}`] });
        }
    }

    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    /** @type {Map<string, string>} method → first offer that needs it */
    const needed = new Map();
    for (const cap of capabilities) for (const m of OFFER_METHODS[cap] || []) if (!needed.has(m)) needed.set(m, cap);
    const proto = WrapperClass && WrapperClass.prototype ? WrapperClass.prototype : {};

    // ── structure ───────────────────────────────────────────────────────────
    if (options.descriptor) {
        await check('descriptor.shape', 'structure', undefined, () => {
            const d = /** @type {Record<string, any>} */ (options.descriptor);
            const problems = [];
            if (d.pluginName !== manifest.pluginName) problems.push(`descriptor.pluginName '${d.pluginName}' ≠ manifest '${manifest.pluginName}'`);
            if (typeof d.WrapperClass !== 'function') problems.push('descriptor.WrapperClass is not a class');
            if (typeof d.SettingsClass !== 'function') problems.push('descriptor.SettingsClass is not a class');
            if (typeof d.displayName !== 'string') problems.push('descriptor.displayName is not a string');
            return problems;
        });
    }
    for (const [method, offer] of needed) {
        await check(`F12.${offer}.has-${method}`, 'structure', 'F12', () => (
            typeof proto[method] === 'function' ? [] : [`declared offer '${offer}' needs '${method}' on WrapperClass.prototype`]
        ));
    }
    await check('IV.no-public-method-outside-the-contract', 'structure', 'IV.public-methods', () => {
        const allowed = new Set([...needed.keys(), ...LIFECYCLE_METHODS]);
        return Object.getOwnPropertyNames(proto)
            .filter((m) => typeof proto[m] === 'function' && !m.startsWith('_') && !allowed.has(m))
            .map((m) => `public method '${m}' is not named by the contract for the declared offers${m === 'compareProgress' ? ' (A13: the host compares)' : ''}`);
    });

    // ── construction ────────────────────────────────────────────────────────
    const settings = options.settings || {};
    /** @type {any} */
    let instance = null;
    await check('harness.init', 'harness', undefined, async () => {
        if (options.initOptions) {
            instance = await WrapperClass.init(options.initOptions);
        } else if (harness === '3.x') {
            instance = await WrapperClass.init({
                context: { utils: createStubContext().utils, cache },
                apiSettings: settingsShim(settings),
                serviceSettings: { ...settings },
                httpClientFactory: () => axios,
                sqliteFactory: () => null,
            });
        } else {
            instance = await WrapperClass.init({ context: { utils: createStubContext().utils, http: axios, cache }, apiSettings: null, serviceSettings: { ...settings } });
        }
        return instance ? [] : ['WrapperClass.init() returned nothing'];
    });
    if (!instance) {
        return { passed, failed };
    }

    /**
     * The host's call: a 3.x wrapper is hydrated first (its delivery), then called with the context appended.
     * @param {string} method
     * @param {any[]} args
     * @param {CallContext} ctx
     */
    async function invoke(method, args, ctx) {
        if (typeof instance[method] !== 'function') {
            throw new Error(`${method} is not a method of the instance`);
        }
        if (harness === '3.x' && typeof instance.setCredentials === 'function') {
            await instance.setCredentials(ctx.credential);
        }
        cache.setActiveScope(ctx.scope);
        try {
            return await instance[method](...args, ctx);
        } finally {
            cache.setActiveScope(null);
        }
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    await check('lifecycle.getStatus-is-cheap', 'shape', 'IV.getStatus', async () => {
        const before = axios.calls.length;
        const pending = instance.getStatus();
        const problems = [];
        if (!pending || typeof pending.then !== 'function') problems.push('getStatus() must return a Promise');
        const status = await pending;
        if (!status || typeof status.status !== 'string') problems.push('getStatus() must resolve to { status }');
        if (axios.calls.length !== before) problems.push('getStatus() made an HTTP call');
        return problems;
    });
    await check('lifecycle.initialize', 'shape', undefined, async () => {
        const out = await instance.initialize();
        return out && typeof out.status === 'string' ? [] : ['initialize() must resolve to { status }'];
    });

    // ── results ─────────────────────────────────────────────────────────────
    /** @type {Record<string, unknown>} */
    const results = {};
    for (const method of needed.keys()) {
        if (method === 'testCredentials') continue;
        const args = inputs[method] || [];
        await check(`result.${method}`, 'shape', /** @type {Record<string, string>} */ (RESULT_FINDINGS)[method], async () => {
            const result = await invoke(method, args, makeContext());
            results[method] = result;
            return validateResult(method, result, { manifest: manifest.syncOptions && manifest.syncOptions.statusVocabulary && manifest.syncOptions.statusVocabulary.pull ? manifest : null, inputIds: inputIdsOf(args) });
        });
        await check(`callContext.${method}-refuses-a-call-without-one`, 'shape', undefined, async () => {
            try {
                await instance[method](...args);
                return [`${method}() accepted a call with no callContext`];
            } catch (error) {
                return isPluginError(error) && error.code === HOST_CONTRACT_VIOLATION
                    ? []
                    : [`${method}() without a callContext must throw host_contract_violation, got ${error instanceof Error ? error.message : String(error)}`];
            }
        });
    }
    if (needed.has('testCredentials')) {
        await check('result.testCredentials', 'shape', 'A9', async () => {
            const result = await instance.testCredentials(makeContext().credential);
            return validateResult('testCredentials', result);
        });
    }

    // ── status ──────────────────────────────────────────────────────────────
    const tokens = sourceTokens(manifest);
    if (tokens && (needed.has('getReadingList') || needed.has('pullProgress'))) {
        await check('status.returned-is-the-source-token', 'behaviour', 'IV.status', () => {
            /** @type {string[]} */
            const problems = [];
            /** @type {unknown[]} */
            const statuses = [];
            if (Array.isArray(results.getReadingList)) statuses.push(...results.getReadingList.map((/** @type {any} */ e) => e && e.status));
            if (results.pullProgress && typeof results.pullProgress === 'object') statuses.push(/** @type {any} */ (results.pullProgress).status);
            for (const status of statuses) {
                if (typeof status === 'string' && HOST_READING_STATUSES.includes(status) && !tokens.has(status)) {
                    problems.push(`returned the host status '${status}' where the source's token belongs (A6: the host resolves)`);
                }
            }
            return problems;
        });
    }
    if (needed.has('subscribe')) {
        await check('status.subscribe-refuses-a-host-status', 'behaviour', 'A6', async () => {
            const hostStatus = HOST_READING_STATUSES.find((s) => !(tokens && tokens.has(s)));
            if (!hostStatus) return [];
            try {
                await invoke('subscribe', [[{ pluginEntryId: 'entry-1', status: hostStatus }]], makeContext());
                return [`subscribe() accepted the host status '${hostStatus}'`];
            } catch (error) {
                return isPluginError(error) && error.code === HOST_CONTRACT_VIOLATION ? [] : [`expected host_contract_violation, got ${String(error)}`];
            }
        });
    }

    // ── credentials ─────────────────────────────────────────────────────────
    if (capabilities.includes('credential') && needed.has('getReadingList')) {
        await check('F3.getReadingList-without-a-credential-is-rejected', 'behaviour', 'F3', async () => {
            try {
                const out = await invoke('getReadingList', [], makeContext({ credential: null }));
                return [`answered ${Array.isArray(out) ? `${out.length} entries` : typeof out} with no credential; expected credential_rejected (never a silent answer)`];
            } catch (error) {
                return isPluginError(error) && error.code === 'credential_rejected'
                    ? []
                    : [`threw '${error instanceof Error ? error.message : String(error)}', not a PluginError 'credential_rejected'`];
            }
        });
    }

    // ── per-entry failure ───────────────────────────────────────────────────
    const original = axios.getHandler();
    for (const method of ARRAY_METHODS.filter((m) => needed.has(m))) {
        const args = inputs[method] || [];
        await check(`perEntry.${method}-never-throws-for-the-batch`, 'behaviour', '§2.1', async () => {
            axios.setHandler(() => ({ status: 503, data: {} }));
            try {
                const result = await invoke(method, args, makeContext());
                const ids = inputIdsOf(args) || [];
                if (!Array.isArray(result) || result.length !== ids.length) return [`expected ${ids.length} per-entry results, got ${JSON.stringify(result)}`];
                return result.filter((/** @type {any} */ r) => r.success !== false).map((/** @type {any} */ r) => `entry '${r.pluginEntryId}' reported success while the source failed`);
            } catch (error) {
                return [`threw for the batch: ${error instanceof Error ? error.message : String(error)}`];
            } finally {
                axios.setHandler(original);
            }
        });
    }
    if (needed.has('unsubscribe')) {
        await check('unsubscribe.is-idempotent', 'behaviour', '§2', async () => {
            axios.setHandler((config) => (String(config.method || '').toLowerCase() === 'delete' ? { status: 404, data: {} } : original(config)));
            try {
                const result = await invoke('unsubscribe', [['entry-1']], makeContext());
                return Array.isArray(result) && result[0] && result[0].success === true
                    ? []
                    : [`removing an entry the source no longer has must be success, got ${JSON.stringify(result)}`];
            } finally {
                axios.setHandler(original);
            }
        });
    }

    // ── identities (F11) ────────────────────────────────────────────────────
    if (needed.has('getReadingList')) {
        await check('F11.no-identity-leaks-across-calls', 'behaviour', 'F11', async () => {
            if (generic) generic.setPhase('A');
            await invoke('getReadingList', [], makeContext({ credential: credA, identity: 'slot-label-a', scope: 'user-label-a' })).catch(() => null);
            const mid = axios.calls.length;
            if (generic) generic.setPhase('B');
            const listB = await invoke('getReadingList', [], makeContext({ credential: credB, identity: 'slot-label-b', scope: 'user-label-b' })).catch(() => null);
            if (generic) generic.setPhase('none');
            const callsB = axios.calls.slice(mid);
            /** @type {string[]} */
            const problems = [];
            // Only A's values that B does not share, and long enough to be distinctive, are evidence of a leak.
            const valuesB = new Set(Object.values(/** @type {Record<string, unknown>} */ (credB || {})).map(String));
            const secretsA = /** @type {string[]} */ (Object.values(/** @type {Record<string, unknown>} */ (credA || {}))
                .filter((v) => typeof v === 'string' && v.length >= 6 && !valuesB.has(v)));
            const tokensA = generic ? [...generic.tokenPhase].filter(([, p]) => p === 'A').map(([t]) => t) : [];
            for (const config of callsB) {
                const text = JSON.stringify({ url: config.url, params: config.params, data: config.data, headers: config.headers });
                for (const leaked of [...secretsA, ...tokensA]) {
                    if (text.includes(leaked)) problems.push(`a call made for identity B carried identity A's '${leaked}' (${config.method || 'get'} ${config.url})`);
                }
            }
            if (callsB.length === 0 && Array.isArray(listB) && listB.length > 0) {
                problems.push(`identity B got ${listB.length} reading-list entries without a single source call of its own: an answer kept for another identity`);
            }
            return problems;
        });
    }
    await check('F11.cache-keys-name-the-scope', 'behaviour', 'F11', () => cache.writes
        .filter((w) => w.scope && !w.key.includes(w.scope))
        .map((w) => `cache key '${w.key}' was written for scope '${w.scope}' but does not name it`));

    // ── fixture expectations ────────────────────────────────────────────────
    if (options.expect && typeof options.expect.readingListLength === 'number' && needed.has('getReadingList')) {
        const expected = options.expect.readingListLength;
        await check('sync.list.returns-the-whole-library', 'behaviour', 'F17', async () => {
            const out = await invoke('getReadingList', [], makeContext());
            return Array.isArray(out) && out.length === expected ? [] : [`expected ${expected} entries, got ${Array.isArray(out) ? out.length : typeof out}`];
        });
    }

    return { passed, failed };
}

module.exports = {
    createStubAxios,
    createStubCache,
    createStubContext,
    createGenericSource,
    callContext,
    credentialFor,
    defaultInputs,
    runConformance,
    LIFECYCLE_METHODS,
};
