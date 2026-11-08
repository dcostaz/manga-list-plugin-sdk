'use strict';

/**
 * defineTrackerPlugin(definition) → the loader's descriptor { pluginName, displayName, WrapperClass,
 * SettingsClass } (contract §1.4; standardization plan Phase 1.1–1.2).
 *
 * A plugin ships a definition — its manifest, its settings document, its auth strategy, a client factory
 * and one binding per contract METHOD its declared offers need — and the facade is generated from it, so
 * a plugin cannot expose a method the contract does not name. Every generated method pops the trailing
 * callContext { credential, identity, scope, signal }, builds a per-call view, and retains nothing after
 * the call. All state hangs off the instance (a WeakMap created per definition), none at module level.
 */

const {
    KNOWN_CAPABILITIES,
    OFFER_METHODS,
    HOST_READING_STATUSES,
    PROGRESS_AXIS_CATALOG,
    PLUGIN_CONTRACT_VERSION,
    CAPABILITY_CREDENTIAL,
    CAPABILITY_FILE_PATH,
    CAPABILITY_FILTERABLE,
} = require('./contract.cjs');
const { PluginError, isPluginError, toPluginError, HOST_CONTRACT_VIOLATION } = require('./errors.cjs');
const { perEntry } = require('./results.cjs');
const { createHttpRuntime } = require('./http.cjs');
const { createScopedCache } = require('./cache.cjs');
const { createSettingsClass } = require('./settings.cjs');

/** Methods whose result is one entry per input (§2.1): a binding's throw becomes per-entry failures. */
const ARRAY_METHODS = Object.freeze({
    enrich: (/** @type {any[]} */ args) => idsOf(args[0]),
    pushProgress: (/** @type {any[]} */ args) => idsOf(args[0]),
    subscribe: (/** @type {any[]} */ args) => idsOf(args[0]),
    unsubscribe: (/** @type {any[]} */ args) => idsOf(args[0]),
    summarizeEntries: (/** @type {any[]} */ args) => idsOf(args[0]),
});

/**
 * @param {unknown} entries
 * @returns {string[]}
 */
function idsOf(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map((e) => (typeof e === 'string' ? e : (e && typeof e === 'object' ? String(/** @type {any} */ (e).pluginEntryId) : String(e))));
}

/**
 * @typedef {{
 *   http: import('./http.cjs').CallHttp,
 *   cache: import('./cache.cjs').ScopedCache,
 *   credential: unknown,
 *   identity: string,
 *   scope: string,
 *   signal: AbortSignal | null,
 *   settings: Record<string, unknown>,
 *   utils: Record<string, any>
 * }} CallViewBase
 */

/** @typedef {CallViewBase & { client: any }} CallView */

/**
 * @typedef {{
 *   manifest: Record<string, any>,
 *   settings?: import('./settings.cjs').SettingsDocument | null,
 *   auth?: import('./http.cjs').AuthStrategy | null,
 *   createClient: (deps: { settings: Record<string, unknown>, utils: Record<string, any>, pluginName: string, addNormalizer: (fn: (response: any) => void) => void }) => (view: CallViewBase) => any,
 *   methods?: Record<string, (view: CallView, ...args: any[]) => Promise<any>>,
 *   mapping?: Record<string, (raw: any, ...args: any[]) => any>,
 *   initialize?: (deps: { settings: Record<string, unknown> }) => Promise<{ status: string, message?: string } | void>,
 *   getStatus?: (deps: { settings: Record<string, unknown> }) => Promise<{ status: string, message?: string }> | { status: string, message?: string }
 * }} TrackerDefinition
 */

/**
 * @param {TrackerDefinition} definition
 */
function defineTrackerPlugin(definition) {
    if (!definition || typeof definition !== 'object') {
        throw new TypeError('defineTrackerPlugin: a definition object is required');
    }
    const manifest = definition.manifest;
    if (!manifest || typeof manifest !== 'object' || typeof manifest.pluginName !== 'string' || !manifest.pluginName) {
        throw new TypeError('defineTrackerPlugin: definition.manifest must be the plugin-package.json object with a pluginName');
    }
    const name = manifest.pluginName;
    /** @param {string} message */
    const fail = (message) => new Error(`defineTrackerPlugin('${name}'): ${message}`);

    if (manifest.pluginType !== 'tracker') {
        throw fail(`pluginType must be 'tracker' (adapters are built by the adapter runtime)`);
    }
    const declaredMajor = String(manifest.pluginContractVersion || '').split('.')[0];
    if (declaredMajor !== PLUGIN_CONTRACT_VERSION.split('.')[0]) {
        throw fail(`manifest pluginContractVersion '${manifest.pluginContractVersion}' is not this SDK's major (${PLUGIN_CONTRACT_VERSION})`);
    }
    const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : null;
    if (!capabilities) {
        throw fail('manifest.capabilities must be an array');
    }
    for (const cap of capabilities) {
        if (!KNOWN_CAPABILITIES.includes(cap)) {
            throw fail(`capability '${cap}' is not in the contract's closed catalog`);
        }
    }
    if (capabilities.includes(CAPABILITY_FILE_PATH) || capabilities.includes(CAPABILITY_FILTERABLE)) {
        throw fail(`'file-path' and 'filterable' belong to the adapter runtime`);
    }
    if (typeof definition.createClient !== 'function') {
        throw fail('definition.createClient must be a function returning a per-call client factory');
    }
    const methods = definition.methods && typeof definition.methods === 'object' ? definition.methods : {};
    // With a mapping module, a method with no explicit binding is bound by convention: the client's source
    // call of the same name, its answer through the mapping's function of the same name (if any).
    const mapping = definition.mapping && typeof definition.mapping === 'object' ? definition.mapping : null;
    const auth = definition.auth || null;
    const declaresCredential = capabilities.includes(CAPABILITY_CREDENTIAL);

    /** @type {Set<string>} */
    const needed = new Set();
    for (const cap of capabilities) {
        for (const method of OFFER_METHODS[cap] || []) {
            needed.add(method);
        }
    }
    const bound = new Set(Object.keys(methods));
    if (declaresCredential && !bound.has('testCredentials')) {
        if (!auth) {
            throw fail(`a 'credential' plugin needs an auth strategy (definition.auth) or its own testCredentials binding`);
        }
    }
    const missing = mapping ? [] : [...needed].filter((m) => m !== 'testCredentials' && !bound.has(m));
    const extra = [...bound].filter((m) => !needed.has(m));
    if (missing.length || extra.length) {
        const parts = [];
        if (missing.length) parts.push(`declared offers need ${missing.map((m) => `'${m}'`).join(', ')} with no binding`);
        if (extra.length) parts.push(`binding${extra.length > 1 ? 's' : ''} ${extra.map((m) => `'${m}'`).join(', ')} serve${extra.length > 1 ? '' : 's'} no declared offer`);
        throw fail(parts.join('; '));
    }
    for (const [method, fn] of Object.entries(methods)) {
        if (typeof fn !== 'function') throw fail(`binding '${method}' is not a function`);
    }

    const pushTable = manifest.syncOptions && manifest.syncOptions.statusVocabulary
        && typeof manifest.syncOptions.statusVocabulary.push === 'object'
        ? manifest.syncOptions.statusVocabulary.push
        : null;
    const pushTokens = new Set(pushTable ? Object.values(pushTable).filter((v) => typeof v === 'string') : []);
    const pushAxes = new Set(
        (manifest.syncOptions && manifest.syncOptions.progressAxes && Array.isArray(manifest.syncOptions.progressAxes.push)
            ? manifest.syncOptions.progressAxes.push
            : []).map((/** @type {any} */ a) => (typeof a === 'string' ? a : a && a.axis))
    );

    const SettingsClass = createSettingsClass(definition.settings || null);

    /**
     * @typedef {{
     *   settings: Record<string, unknown>,
     *   utils: Record<string, any>,
     *   runtime: ReturnType<typeof createHttpRuntime>,
     *   cache: ReturnType<typeof createScopedCache>,
     *   clientFactory: (view: CallViewBase) => any
     * }} InstanceState
     */
    /** @type {WeakMap<object, InstanceState>} */
    const states = new WeakMap();

    /**
     * @param {object} instance
     * @returns {InstanceState}
     */
    function stateOf(instance) {
        const st = states.get(instance);
        if (!st) throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: a method was called on an object WrapperClass.init() did not build`);
        return st;
    }

    /**
     * @param {unknown} ctx
     * @returns {{ credential: unknown, identity: string, scope: string, signal: AbortSignal | null }}
     */
    function readCallContext(ctx) {
        if (!ctx || typeof ctx !== 'object' || !('credential' in ctx)) {
            throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: the call carried no callContext { credential, identity, scope, signal } as its last argument`);
        }
        const c = /** @type {Record<string, any>} */ (ctx);
        if (typeof c.identity !== 'string' || !c.identity || typeof c.scope !== 'string' || !c.scope) {
            throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: callContext.identity and callContext.scope must be non-empty labels`);
        }
        const signal = c.signal === undefined || c.signal === null ? null : c.signal;
        if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
            throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: callContext.signal must be an AbortSignal or null`);
        }
        return { credential: c.credential, identity: c.identity, scope: c.scope, signal };
    }

    /**
     * @param {InstanceState} st
     * @param {{ credential: unknown, identity: string, scope: string, signal: AbortSignal | null }} call
     * @returns {CallView}
     */
    function viewFor(st, call) {
        /** @type {CallViewBase} */
        const base = {
            http: st.runtime.bind(call),
            cache: st.cache.bind(call.scope),
            credential: call.credential,
            identity: call.identity,
            scope: call.scope,
            signal: call.signal,
            settings: st.settings,
            utils: st.utils,
        };
        return { ...base, client: st.clientFactory(base) };
    }

    /**
     * What the host must never send (contract §2.2, §2.6): a host reading status where the source's token
     * belongs, or an axis the manifest does not declare for push.
     * @param {string} method
     * @param {any[]} args
     */
    function checkInputs(method, args) {
        if (method === 'subscribe' && Array.isArray(args[0])) {
            for (const entry of args[0]) {
                const status = entry && typeof entry === 'object' ? entry.status : undefined;
                if (typeof status === 'string' && HOST_READING_STATUSES.includes(status) && !pushTokens.has(status)) {
                    throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: subscribe() received the host status '${status}' where the source's token belongs (resolve it through statusVocabulary.push)`);
                }
            }
        }
        if (method === 'pushProgress' && Array.isArray(args[0])) {
            for (const entry of args[0]) {
                for (const axis of PROGRESS_AXIS_CATALOG) {
                    if (entry && typeof entry === 'object' && entry[axis] !== undefined && !pushAxes.has(axis)) {
                        throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: pushProgress() received '${axis}', which syncOptions.progressAxes.push does not declare`);
                    }
                }
            }
        }
    }

    /**
     * The convention binding (used when the definition gives a mapping and no explicit binding): the client
     * exposes one source call per contract method, named after it; the mapping turns its answer into the DTO.
     * An array method is called per entry, through perEntry().
     * @param {string} method
     * @returns {(view: CallView, ...args: any[]) => Promise<any>}
     */
    function conventionBinding(method) {
        const mapOne = mapping && typeof mapping[method] === 'function' ? mapping[method] : null;
        const perEntryMethod = Object.prototype.hasOwnProperty.call(ARRAY_METHODS, method);
        return async (view, ...args) => {
            const client = view.client;
            if (!client || typeof client[method] !== 'function') {
                throw new PluginError('source_error', `${name}: the client has no '${method}' source call for the convention binding`);
            }
            if (perEntryMethod) {
                return perEntry(args[0], async (/** @type {any} */ entry) => {
                    const raw = await client[method](entry, ...args.slice(1));
                    const out = mapOne ? mapOne(raw, entry) : raw;
                    return out && typeof out === 'object' ? out : {};
                });
            }
            const raw = await client[method](...args);
            return mapOne ? mapOne(raw, ...args) : raw;
        };
    }

    class WrapperClass {
        static get pluginName() {
            return name;
        }

        /**
         * Built by the host on every settings save and at every login (contract §1.4).
         * @param {{ context?: { http?: any, cache?: any, utils?: Record<string, any> } | null, apiSettings?: { getAll?: () => Record<string, unknown> } | null, serviceSettings?: Record<string, unknown> | null }} [options]
         * @returns {Promise<WrapperClass>}
         */
        static async init(options = {}) {
            const context = options.context || {};
            const settings = options.serviceSettings && typeof options.serviceSettings === 'object'
                ? { ...options.serviceSettings }
                : (options.apiSettings && typeof options.apiSettings.getAll === 'function'
                    ? options.apiSettings.getAll()
                    : (definition.settings ? { ...definition.settings.settings } : {}));
            const utils = context.utils && typeof context.utils === 'object' ? context.utils : {};
            const runtime = createHttpRuntime({ axios: context.http || null, settings, auth });
            const clientFactory = definition.createClient({
                settings,
                utils,
                pluginName: name,
                addNormalizer: (fn) => runtime.addNormalizer(fn),
            });
            if (typeof clientFactory !== 'function') {
                throw fail('createClient() must return a function (view) => client');
            }
            const instance = new WrapperClass();
            states.set(instance, { settings, utils, runtime, cache: createScopedCache(context.cache || null), clientFactory });
            return instance;
        }

        /** @returns {Promise<{ status: string, message?: string }>} */
        async initialize() {
            const st = stateOf(this);
            if (typeof definition.initialize === 'function') {
                const out = await definition.initialize({ settings: st.settings });
                if (out && typeof out === 'object' && typeof out.status === 'string') return out;
            }
            return { status: 'ok' };
        }

        /** Cheap: no HTTP call, no data fetch (contract §2.6). @returns {Promise<{ status: string, message?: string }>} */
        async getStatus() {
            const st = stateOf(this);
            if (typeof definition.getStatus === 'function') {
                return definition.getStatus({ settings: st.settings });
            }
            return { status: 'ok' };
        }
    }

    const proto = /** @type {Record<string, any>} */ (WrapperClass.prototype);

    if (declaresCredential) {
        const binding = methods.testCredentials;
        let testRuns = 0;
        /**
         * testCredentials(credential, callContext?) → boolean; false for a refused credential, never a throw
         * for that; a transport failure throws a PluginError.
         * @this {WrapperClass}
         * @param {unknown} credential
         * @param {unknown} [ctx]
         */
        proto.testCredentials = async function testCredentials(credential, ctx) {
            const st = stateOf(this);
            // The credential under test is not the slot's: it gets an identity of its own, used once, so no token
            // it mints is kept, and no token kept for another credential answers for it.
            testRuns += 1;
            const identity = `credential-test:${testRuns}:${Math.random().toString(36).slice(2)}`;
            const call = ctx === undefined
                ? { credential, identity, scope: 'system', signal: null }
                : { ...readCallContext(ctx), credential, identity };
            const view = viewFor(st, call);
            try {
                if (binding) {
                    return (await binding(view, credential)) === true;
                }
                // Under the convention, a client that can ask the source whether the credential is good (a
                // static key needs no exchange, so the exchange alone proves nothing) answers it.
                if (mapping && view.client && typeof view.client.testCredentials === 'function') {
                    return (await view.client.testCredentials(credential)) === true;
                }
                await /** @type {import('./http.cjs').AuthStrategy} */ (auth).exchange(credential, { http: view.http, settings: st.settings, previous: null, reason: 'initial' });
                return true;
            } catch (error) {
                if (isPluginError(error) && error.code === 'credential_rejected') return false;
                throw toPluginError(error);
            } finally {
                st.runtime.tokens.invalidate(identity);
            }
        };
    }

    for (const method of needed) {
        if (method === 'testCredentials') continue;
        const binding = methods[method] || conventionBinding(method);
        const idsFor = /** @type {Record<string, (args: any[]) => string[]>} */ (ARRAY_METHODS)[method];
        proto[method] = {
            /**
             * @this {WrapperClass}
             * @param {...any} args
             */
            async [method](...args) {
                const st = stateOf(this);
                const call = readCallContext(args.pop());
                checkInputs(method, args);
                const view = viewFor(st, call);
                try {
                    return await binding(view, ...args);
                } catch (error) {
                    if (isPluginError(error) && error.code === HOST_CONTRACT_VIOLATION) throw error;
                    const pluginError = toPluginError(error);
                    if (idsFor) {
                        // §2.1: never a whole-batch throw — every entry fails with the call's code.
                        return idsFor(args).map((pluginEntryId) => ({ pluginEntryId, success: false, error: pluginError.toEntryError() }));
                    }
                    if (method === 'queryLive') {
                        if (pluginError.code === 'not_found') return { status: 'not_found' };
                        if (pluginError.code === 'offline') return { status: 'offline', message: pluginError.message };
                        return { status: 'error', message: pluginError.message, retryable: pluginError.code === 'rate_limited' };
                    }
                    throw pluginError;
                }
            },
        }[method];
    }

    return Object.freeze({
        pluginName: name,
        displayName: typeof manifest.displayName === 'string' ? manifest.displayName : name,
        WrapperClass,
        SettingsClass,
    });
}

module.exports = { defineTrackerPlugin };
