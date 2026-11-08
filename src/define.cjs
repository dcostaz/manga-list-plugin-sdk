'use strict';

/**
 * definePlugin(definition) → the loader's descriptor { pluginName, displayName, WrapperClass,
 * SettingsClass } (contract §1.4; standardization plan Phase 1.1–1.2; adapter plan Phase 1).
 *
 * A plugin ships a definition — its manifest, its settings document, its auth strategy, a client factory
 * and one binding per contract METHOD its declarations need — and the facade is generated from it, so
 * a plugin cannot expose a method the contract does not name. One definition for every plugin type
 * (adapter plan Decision 5): what must be bound follows the manifest — the access offer, each operation
 * offer, `filterable`, a `workspace.entry` block. Every generated method pops the trailing callContext
 * { credential, identity, scope, signal }, builds a per-call view, and retains nothing after the call. A
 * `file-path` plugin's credential is its path grant (A19): `view.paths`, never its settings. All state
 * hangs off the instance (a WeakMap created per definition), none at module level.
 */

const path = require('path');
const {
    KNOWN_CAPABILITIES,
    OFFER_METHODS,
    OWN_READ_METHODS,
    TRANSITIONAL_READ_METHODS,
    HOST_READING_STATUSES,
    PROGRESS_AXIS_CATALOG,
    PLUGIN_CONTRACT_VERSION,
    MIN_ADAPTER_CONTRACT_VERSION,
    CAPABILITY_CREDENTIAL,
    CAPABILITY_FILE_PATH,
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
 * @param {string} a
 * @param {string} b
 * @returns {number} <0, 0, >0
 */
function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i += 1) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

/**
 * @typedef {{
 *   http: import('./http.cjs').CallHttp,
 *   cache: import('./cache.cjs').ScopedCache,
 *   credential: unknown,
 *   paths: Record<string, string> | null,
 *   sqlite: any,
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
 *   createClient: (deps: { settings: Record<string, unknown>, utils: Record<string, any>, sqlite: any, pluginName: string, addNormalizer: (fn: (response: any) => void) => void }) => (view: CallViewBase) => any,
 *   methods?: Record<string, (view: CallView, ...args: any[]) => Promise<any>>,
 *   mapping?: Record<string, (raw: any, ...args: any[]) => any>,
 *   initialize?: (deps: { settings: Record<string, unknown> }) => Promise<{ status: string, message?: string } | void>,
 *   getStatus?: (deps: { settings: Record<string, unknown> }) => Promise<{ status: string, message?: string }> | { status: string, message?: string }
 * }} PluginDefinition
 */

/** @typedef {PluginDefinition} TrackerDefinition */

/**
 * @param {PluginDefinition} definition
 */
function definePlugin(definition) {
    if (!definition || typeof definition !== 'object') {
        throw new TypeError('definePlugin: a definition object is required');
    }
    const manifest = definition.manifest;
    if (!manifest || typeof manifest !== 'object' || typeof manifest.pluginName !== 'string' || !manifest.pluginName) {
        throw new TypeError('definePlugin: definition.manifest must be the plugin-package.json object with a pluginName');
    }
    const name = manifest.pluginName;
    /** @param {string} message */
    const fail = (message) => new Error(`definePlugin('${name}'): ${message}`);

    const types = Array.isArray(manifest.pluginType) ? manifest.pluginType : [manifest.pluginType];
    if (!types.length || types.some((t) => t !== 'tracker' && t !== 'adapter')) {
        throw fail(`pluginType must be 'tracker' or 'adapter' (where the source's data lives)`);
    }
    const declaredMajor = String(manifest.pluginContractVersion || '').split('.')[0];
    if (declaredMajor !== PLUGIN_CONTRACT_VERSION.split('.')[0]) {
        throw fail(`manifest pluginContractVersion '${manifest.pluginContractVersion}' is not this SDK's major (${PLUGIN_CONTRACT_VERSION})`);
    }
    if (types.includes('adapter') && compareVersions(manifest.pluginContractVersion, MIN_ADAPTER_CONTRACT_VERSION) < 0) {
        throw fail(`an adapter is built for contract ${MIN_ADAPTER_CONTRACT_VERSION} or later (A17); the manifest says '${manifest.pluginContractVersion}'`);
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
    const declaresCredential = capabilities.includes(CAPABILITY_CREDENTIAL);
    const declaresFilePath = capabilities.includes(CAPABILITY_FILE_PATH);
    if (declaresCredential === declaresFilePath) {
        throw fail(`exactly one access offer applies per plugin, 'credential' or 'file-path' (§1.1)`);
    }
    /** @type {string[]} the settings that make up the path grant (§1.4 filePathOptions.fields) */
    const pathKeys = [];
    if (declaresFilePath) {
        const fields = manifest.filePathOptions && Array.isArray(manifest.filePathOptions.fields) ? manifest.filePathOptions.fields : null;
        if (!fields || !fields.length) {
            throw fail(`a 'file-path' plugin declares its path settings in filePathOptions.fields (§1.4)`);
        }
        for (const field of fields) {
            if (!field || typeof field.key !== 'string' || !field.key || (field.kind !== 'file' && field.kind !== 'directory')) {
                throw fail(`filePathOptions.fields entries are { key, label, kind: 'file' | 'directory' }`);
            }
            pathKeys.push(field.key);
        }
    }
    const filterSchema = manifest.filterSchema && typeof manifest.filterSchema === 'object' ? manifest.filterSchema : null;
    if (capabilities.includes('filterable') && (!filterSchema || !Object.keys(filterSchema).length)) {
        throw fail(`a 'filterable' plugin declares its fields in filterSchema (§1.4)`);
    }
    const hasWorkspaceEntry = !!(manifest.workspace && typeof manifest.workspace === 'object' && manifest.workspace.entry);
    if (typeof definition.createClient !== 'function') {
        throw fail('definition.createClient must be a function returning a per-call client factory');
    }
    const methods = definition.methods && typeof definition.methods === 'object' ? definition.methods : {};
    // With a mapping module, a method with no explicit binding is bound by convention: the client's source
    // call of the same name, its answer through the mapping's function of the same name (if any).
    const mapping = definition.mapping && typeof definition.mapping === 'object' ? definition.mapping : null;
    const auth = definition.auth || null;

    /** @type {Set<string>} */
    const needed = new Set();
    for (const cap of capabilities) {
        for (const method of OFFER_METHODS[cap] || []) {
            needed.add(method);
        }
    }
    if (hasWorkspaceEntry) {
        for (const method of OWN_READ_METHODS) needed.add(method);
    }
    const bound = new Set(Object.keys(methods));
    // §5.4's one transitional read: bound only by a plugin that already has it (A23).
    for (const method of TRANSITIONAL_READ_METHODS) {
        if (bound.has(method)) needed.add(method);
    }
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
     *   sqlite: any,
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
        if (declaresFilePath) {
            readPathGrant(c.credential);
        }
        return { credential: c.credential, identity: c.identity, scope: c.scope, signal };
    }

    /**
     * A `file-path` plugin's credential is its path grant (A19): `{ [key]: absolute path }`, one per declared field.
     * @param {unknown} grant
     * @returns {Record<string, string>}
     */
    function readPathGrant(grant) {
        if (!grant || typeof grant !== 'object') {
            throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: a 'file-path' call carries its path grant in callContext.credential (A19)`);
        }
        const g = /** @type {Record<string, unknown>} */ (grant);
        /** @type {Record<string, string>} */
        const paths = {};
        for (const key of pathKeys) {
            const value = g[key];
            if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
                throw new PluginError(HOST_CONTRACT_VIOLATION, `${name}: the path grant's '${key}' must be an absolute path`);
            }
            paths[key] = value;
        }
        return paths;
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
            paths: declaresFilePath ? readPathGrant(call.credential) : null,
            sqlite: st.sqlite,
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
     * A21: a spec naming no `filterSchema` field is not applicable — an answer, and the binding is not called.
     * @param {unknown} spec
     */
    function filterApplies(spec) {
        const fields = spec && typeof spec === 'object' && /** @type {any} */ (spec).fields && typeof /** @type {any} */ (spec).fields === 'object'
            ? /** @type {Record<string, unknown>} */ (/** @type {any} */ (spec).fields)
            : {};
        return Object.keys(fields).some((key) => !!filterSchema && Object.prototype.hasOwnProperty.call(filterSchema, key)
            && fields[key] !== undefined && fields[key] !== null && fields[key] !== '');
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
         * Built by the host on every settings save and at every login (contract §1.4). A `file-path` plugin's
         * path settings are removed from what it sees: its paths arrive with each call (A19).
         * @param {{ context?: { http?: any, cache?: any, utils?: Record<string, any>, sqlite?: any } | null, apiSettings?: { getAll?: () => Record<string, unknown> } | null, serviceSettings?: Record<string, unknown> | null }} [options]
         * @returns {Promise<WrapperClass>}
         */
        static async init(options = {}) {
            const context = options.context || {};
            const settings = options.serviceSettings && typeof options.serviceSettings === 'object'
                ? { ...options.serviceSettings }
                : (options.apiSettings && typeof options.apiSettings.getAll === 'function'
                    ? { ...options.apiSettings.getAll() }
                    : (definition.settings ? { ...definition.settings.settings } : {}));
            for (const key of pathKeys) delete settings[key];
            const utils = context.utils && typeof context.utils === 'object' ? context.utils : {};
            const sqlite = context.sqlite || null;
            const runtime = createHttpRuntime({ axios: context.http || null, settings, auth });
            const clientFactory = definition.createClient({
                settings,
                utils,
                sqlite,
                pluginName: name,
                addNormalizer: (fn) => runtime.addNormalizer(fn),
            });
            if (typeof clientFactory !== 'function') {
                throw fail('createClient() must return a function (view) => client');
            }
            const instance = new WrapperClass();
            states.set(instance, { settings, utils, runtime, cache: createScopedCache(context.cache || null), sqlite, clientFactory });
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
                if (method === 'queryFilter' && !filterApplies(args[0])) {
                    return { applicable: false, pluginEntryIds: [] };
                }
                const view = viewFor(st, call);
                try {
                    const out = await binding(view, ...args);
                    if (method === 'queryFilter' && Array.isArray(out)) {
                        return { applicable: true, pluginEntryIds: out.map(String) };
                    }
                    return out;
                } catch (error) {
                    if (isPluginError(error) && error.code === HOST_CONTRACT_VIOLATION) throw error;
                    const pluginError = toPluginError(error);
                    if (idsFor) {
                        // §2.1: never a whole-batch throw — every entry fails with the call's code.
                        return idsFor(args).map((pluginEntryId) => ({ pluginEntryId, success: false, error: pluginError.toEntryError() }));
                    }
                    if (method === 'getEntry' && pluginError.code === 'not_found') {
                        return null; // §5.4: an id the plugin does not know answers null
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

/** One definition for every plugin type (adapter plan Decision 5); both names are aliases of it. */
const defineTrackerPlugin = definePlugin;
const defineAdapterPlugin = definePlugin;

module.exports = { definePlugin, defineTrackerPlugin, defineAdapterPlugin };
