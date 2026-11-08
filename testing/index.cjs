'use strict';

/**
 * @manga-list/plugin-sdk/testing — the contract's executable form (standardization plan Phase 1.7).
 *
 * The unit under test is a loaded WrapperClass behind the contract boundary, whether built by
 * defineTrackerPlugin() or hand-written. Phase 1 ships the structural and shape cases; the standardization
 * plan's Phase 2 adds the behaviour cases (identities, pagination, status tokens, the analysis's
 * reproductions) to the same runner.
 */

const { OFFER_METHODS, HOST_READING_STATUSES } = require('../src/contract.cjs');
const { validateResult } = require('../src/validators.cjs');
const { isPluginError, HOST_CONTRACT_VIOLATION } = require('../src/errors.cjs');

/** Lifecycle and access methods a WrapperClass may carry beside its §2 operation methods. */
const LIFECYCLE_METHODS = Object.freeze(['constructor', 'initialize', 'getStatus', 'testCredentials']);

/**
 * @typedef {{ status?: number, data?: unknown, headers?: Record<string, string> }} StubResponse
 * @typedef {(config: Record<string, any>) => StubResponse | Promise<StubResponse>} StubHandler
 */

/**
 * An axios-shaped stub: `request(config)` answers through `handler`, records every call, and throws an
 * axios-shaped error (`error.response.status`) for a status of 400 or more.
 * @param {StubHandler} [handler]
 */
function createStubAxios(handler) {
    /** @type {Array<Record<string, any>>} */
    const calls = [];
    /** @type {StubHandler} */
    const respond = handler || (() => ({ status: 200, data: {} }));
    return {
        calls,
        /** @param {Record<string, any>} config */
        async request(config) {
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
        },
    };
}

/** An in-memory host cache adapter that records the keys written. */
function createStubCache() {
    /** @type {Map<string, unknown>} */
    const store = new Map();
    return {
        store,
        /** @param {string} key */
        async getValue(key) {
            return store.has(key) ? store.get(key) : null;
        },
        /** @param {string} key @param {unknown} value */
        async setValue(key, value) {
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
 */
function callContext(overrides = {}) {
    return {
        credential: overrides.credential === undefined ? { token: 'stub-credential' } : overrides.credential,
        identity: overrides.identity || 'slot-label-a',
        scope: overrides.scope || 'user-label-a',
        signal: overrides.signal === undefined ? null : overrides.signal,
    };
}

/**
 * Sample arguments per method (everything but the callContext). A plugin under test may override them.
 * @param {Record<string, any>} manifest
 * @returns {Record<string, any[]>}
 */
function defaultInputs(manifest) {
    const sync = manifest.syncOptions || {};
    const push = sync.statusVocabulary && sync.statusVocabulary.push ? sync.statusVocabulary.push : {};
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
 * Run the contract cases against a WrapperClass.
 *
 * @param {{
 *   WrapperClass: any,
 *   manifest: Record<string, any>,
 *   descriptor?: Record<string, any> | null,
 *   initOptions?: Record<string, any>,
 *   axios?: { calls: any[] } | null,
 *   inputs?: Record<string, any[]>,
 *   context?: (overrides?: object) => { credential: unknown, identity: string, scope: string, signal: AbortSignal | null },
 * }} options
 * @returns {Promise<{ passed: string[], failed: Array<{ id: string, problems: string[] }> }>}
 */
async function runConformance(options) {
    const { WrapperClass, manifest } = options;
    const inputs = { ...defaultInputs(manifest), ...(options.inputs || {}) };
    const makeContext = options.context || callContext;
    /** @type {string[]} */
    const passed = [];
    /** @type {Array<{ id: string, problems: string[] }>} */
    const failed = [];
    /**
     * @param {string} id
     * @param {() => Promise<string[]> | string[]} run
     */
    async function check(id, run) {
        try {
            const problems = await run();
            if (problems.length) failed.push({ id, problems });
            else passed.push(id);
        } catch (error) {
            failed.push({ id, problems: [`threw: ${error instanceof Error ? error.message : String(error)}`] });
        }
    }

    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    /** @type {Set<string>} */
    const needed = new Set();
    for (const cap of capabilities) for (const m of OFFER_METHODS[cap] || []) needed.add(m);

    if (options.descriptor) {
        await check('descriptor.shape', () => {
            const d = /** @type {Record<string, any>} */ (options.descriptor);
            const problems = [];
            if (d.pluginName !== manifest.pluginName) problems.push(`descriptor.pluginName '${d.pluginName}' ≠ manifest '${manifest.pluginName}'`);
            if (typeof d.WrapperClass !== 'function') problems.push('descriptor.WrapperClass is not a class');
            if (typeof d.SettingsClass !== 'function') problems.push('descriptor.SettingsClass is not a class');
            if (typeof d.displayName !== 'string') problems.push('descriptor.displayName is not a string');
            return problems;
        });
    }

    await check('methods.declared-offers-have-methods', () => {
        return [...needed]
            .filter((m) => typeof WrapperClass.prototype[m] !== 'function')
            .map((m) => `declared offers need '${m}' on WrapperClass.prototype`);
    });

    await check('methods.none-outside-the-contract', () => {
        const allowed = new Set([...needed, ...LIFECYCLE_METHODS]);
        return Object.getOwnPropertyNames(WrapperClass.prototype)
            .filter((m) => typeof WrapperClass.prototype[m] === 'function' && !m.startsWith('_') && !allowed.has(m))
            .map((m) => `public method '${m}' is not named by the contract for the declared offers`);
    });

    const instance = await WrapperClass.init(options.initOptions || {});

    await check('lifecycle.getStatus-is-cheap', async () => {
        const before = options.axios ? options.axios.calls.length : 0;
        const pending = instance.getStatus();
        const problems = [];
        if (!pending || typeof pending.then !== 'function') problems.push('getStatus() must return a Promise');
        const status = await pending;
        if (!status || typeof status.status !== 'string') problems.push('getStatus() must resolve to { status }');
        if (options.axios && options.axios.calls.length !== before) problems.push('getStatus() made an HTTP call');
        return problems;
    });

    await check('lifecycle.initialize', async () => {
        const out = await instance.initialize();
        return out && typeof out.status === 'string' ? [] : ['initialize() must resolve to { status }'];
    });

    for (const method of needed) {
        if (method === 'testCredentials') continue;
        const args = inputs[method] || [];
        await check(`result.${method}`, async () => {
            const result = await instance[method](...args, makeContext());
            return validateResult(method, result, { manifest, inputIds: inputIdsOf(args) });
        });
        await check(`callContext.${method}-refuses-a-call-without-one`, async () => {
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

    if (needed.has('subscribe')) {
        await check('status.subscribe-refuses-a-host-status', async () => {
            const push = manifest.syncOptions && manifest.syncOptions.statusVocabulary ? manifest.syncOptions.statusVocabulary.push || {} : {};
            const tokens = new Set(Object.values(push));
            const hostStatus = HOST_READING_STATUSES.find((s) => !tokens.has(s));
            if (!hostStatus) return [];
            try {
                await instance.subscribe([{ pluginEntryId: 'entry-1', status: hostStatus }], makeContext());
                return [`subscribe() accepted the host status '${hostStatus}'`];
            } catch (error) {
                return isPluginError(error) && error.code === HOST_CONTRACT_VIOLATION ? [] : [`expected host_contract_violation, got ${String(error)}`];
            }
        });
    }

    if (needed.has('testCredentials')) {
        await check('result.testCredentials', async () => {
            const result = await instance.testCredentials(makeContext().credential);
            return validateResult('testCredentials', result);
        });
    }

    return { passed, failed };
}

module.exports = {
    createStubAxios,
    createStubCache,
    createStubContext,
    callContext,
    defaultInputs,
    runConformance,
    LIFECYCLE_METHODS,
};
