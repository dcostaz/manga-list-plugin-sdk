'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { defineTrackerPlugin, isPluginError } = require('../index.cjs');
const { createStubAxios, createStubContext, callContext } = require('../testing/index.cjs');
const fixture = require('./fixtures/throwaway.cjs');

/** @param {Record<string, any>} [overrides] */
function minimalDefinition(overrides = {}) {
    return {
        manifest: {
            pluginName: 'mini', displayName: 'Mini', pluginType: 'tracker', pluginContractVersion: '4.0.0', hostApiVersion: '1.0.0',
            capabilities: ['search.query', 'sync.list', 'watch.list'],
            entrypoints: { pluginModule: 'plugin-mini.cjs', settingsFile: 'mini.json' },
        },
        settings: { metadata: { componentName: 'MiniAPI' }, schema: {}, settings: {} },
        createClient: () => () => ({}),
        methods: {
            search: async () => [],
            getReadingList: async () => [],
        },
        ...overrides,
    };
}

async function instanceOf(descriptor = fixture.descriptor, handler = fixture.sourceHandler) {
    const axios = createStubAxios(handler);
    const instance = await descriptor.WrapperClass.init({ context: createStubContext({ axios }) });
    return { instance, axios };
}

test('the descriptor is the loader\'s shape', () => {
    const d = fixture.descriptor;
    assert.equal(d.pluginName, 'throwaway');
    assert.equal(d.displayName, 'Throwaway');
    assert.equal(typeof d.WrapperClass, 'function');
    assert.equal(typeof d.SettingsClass, 'function');
    assert.equal(d.WrapperClass.pluginName, 'throwaway');
});

test('two offers over one method bind it once', () => {
    const d = defineTrackerPlugin(/** @type {any} */ (minimalDefinition()));
    assert.equal(typeof d.WrapperClass.prototype.getReadingList, 'function');
});

test('a declared offer whose method has no binding fails at definition time, by name', () => {
    const def = minimalDefinition({ methods: { search: async () => [] } });
    assert.throws(() => defineTrackerPlugin(/** @type {any} */ (def)), /'getReadingList' with no binding/);
});

test('a binding no declared offer needs fails at definition time, by name', () => {
    const def = minimalDefinition();
    def.methods = { ...def.methods, lookup: async () => ({}) };
    assert.throws(() => defineTrackerPlugin(/** @type {any} */ (def)), /'lookup' serves no declared offer/);
});

test('a credential plugin without an auth strategy or testCredentials binding is refused', () => {
    const def = minimalDefinition();
    def.manifest.capabilities = ['credential', ...def.manifest.capabilities];
    assert.throws(() => defineTrackerPlugin(/** @type {any} */ (def)), /auth strategy/);
});

test('a manifest of another contract major is refused', () => {
    const def = minimalDefinition();
    def.manifest.pluginContractVersion = '3.0.0';
    assert.throws(() => defineTrackerPlugin(/** @type {any} */ (def)), /not this SDK's major/);
});

test('a call without a callContext is a host_contract_violation', async () => {
    const { instance } = await instanceOf();
    await assert.rejects(instance.search('x'), (e) => isPluginError(e) && e.code === 'host_contract_violation');
});

test('every positional argument is passed, so callContext is last even when an optional one is omitted', async () => {
    const { instance, axios } = await instanceOf();
    const out = await instance.search('one', undefined, callContext());
    assert.equal(out[0].pluginEntryId, '1');
    assert.equal(axios.calls[0].params.q, 'one');
});

test('the credential travels in the call: two identities, two sessions, nothing held between calls', async () => {
    const { instance, axios } = await instanceOf();
    await instance.getReadingList(callContext({ credential: { apiKey: 'good' }, identity: 'slot-a' }));
    await instance.getReadingList(callContext({ credential: { apiKey: 'good' }, identity: 'slot-a' }));
    const loginsAfterA = axios.calls.filter((c) => String(c.url).endsWith('/login')).length;
    assert.equal(loginsAfterA, 1, 'slot-a exchanged once and reused its token');
    await instance.getReadingList(callContext({ credential: { apiKey: 'good' }, identity: 'slot-b' }));
    const loginsAfterB = axios.calls.filter((c) => String(c.url).endsWith('/login')).length;
    assert.equal(loginsAfterB, 2, 'slot-b has its own token');
    assert.equal(Object.keys(instance).length, 0, 'the instance carries no public state');
});

test('a credentialed call with no credential is credential_rejected, never a silent empty answer (F3)', async () => {
    const { instance } = await instanceOf();
    await assert.rejects(
        instance.getReadingList(callContext({ credential: null })),
        (e) => isPluginError(e) && e.code === 'credential_rejected',
    );
});

test('an array method never throws for the batch: every entry fails with the call\'s code', async () => {
    const { instance } = await instanceOf();
    const out = await instance.unsubscribe(['a', 'b'], callContext({ credential: null }));
    assert.deepEqual(out.map((/** @type {any} */ r) => [r.pluginEntryId, r.success, r.error.code]), [['a', false, 'credential_rejected'], ['b', false, 'credential_rejected']]);
});

test('subscribe() refuses a host status where the source token belongs', async () => {
    const { instance } = await instanceOf();
    await assert.rejects(
        instance.subscribe([{ pluginEntryId: '1', status: 'READING' }], callContext({ credential: { apiKey: 'good' } })),
        (e) => isPluginError(e) && e.code === 'host_contract_violation',
    );
});

test('pushProgress() refuses an axis the manifest does not declare for push', async () => {
    const def = minimalDefinition();
    def.manifest.capabilities = ['sync.push'];
    def.manifest.syncOptions = { progressAxes: { push: ['chapter'] } };
    def.methods = { pushProgress: async () => [] };
    const d = defineTrackerPlugin(/** @type {any} */ (def));
    const instance = await d.WrapperClass.init({ context: createStubContext() });
    await assert.rejects(
        instance.pushProgress([{ pluginEntryId: '1', rating: 9 }], callContext()),
        (e) => isPluginError(e) && e.code === 'host_contract_violation',
    );
});

test('queryLive() maps a not_found throw to its result arm', async () => {
    const d = defineTrackerPlugin(/** @type {any} */ ({
        ...minimalDefinition(),
        manifest: { ...minimalDefinition().manifest, capabilities: ['watch.entry'] },
        methods: { queryLive: async () => { throw new (require('../index.cjs').PluginError)('not_found', 'gone'); } },
    }));
    const instance = await d.WrapperClass.init({ context: createStubContext() });
    assert.deepEqual(await instance.queryLive('1', callContext()), { status: 'not_found' });
});

test('testCredentials: true for a good credential, false for a refused one, no throw for that', async () => {
    const { instance } = await instanceOf();
    assert.equal(await instance.testCredentials({ apiKey: 'good' }), true);
    assert.equal(await instance.testCredentials({ apiKey: 'bad' }), false);
});

test('getStatus() resolves without an HTTP call', async () => {
    const { instance, axios } = await instanceOf();
    const pending = instance.getStatus();
    assert.equal(typeof pending.then, 'function');
    assert.deepEqual(await pending, { status: 'ok' });
    assert.equal(axios.calls.length, 0);
});

test('createClient runs once per instance; the client is built per call over the bound view', async () => {
    let created = 0;
    /** @type {any[]} */
    const views = [];
    const def = minimalDefinition({
        createClient: () => { created += 1; return (/** @type {any} */ view) => { views.push(view); return {}; }; },
    });
    const d = defineTrackerPlugin(/** @type {any} */ (def));
    const instance = await d.WrapperClass.init({ context: createStubContext() });
    await instance.search('a', undefined, callContext({ identity: 'i1', scope: 's1' }));
    await instance.search('b', undefined, callContext({ identity: 'i2', scope: 's2' }));
    assert.equal(created, 1);
    assert.deepEqual(views.map((v) => [v.identity, v.scope]), [['i1', 's1'], ['i2', 's2']]);
});

test('with a mapping, unbound methods are bound by convention: client.<method> → mapping.<method>, array methods per entry', async () => {
    const def = minimalDefinition({
        methods: undefined,
        mapping: {
            /** @param {any[]} raw */
            search: (raw) => raw.map((r) => ({ pluginEntryId: String(r.id), title: r.name, confidence: 1, canonicalUrl: null })),
        },
        createClient: () => () => ({
            search: async () => [{ id: 7, name: 'Seven' }],
            getReadingList: async () => [],
        }),
    });
    def.manifest.capabilities = ['search.query', 'sync.list', 'subscribe.remove'];
    const client = { search: async () => [{ id: 7, name: 'Seven' }], getReadingList: async () => [], unsubscribe: async (/** @type {string} */ id) => { if (id === 'bad') throw new (require('../index.cjs').PluginError)('offline', 'down'); } };
    def.createClient = () => () => client;
    const d = defineTrackerPlugin(/** @type {any} */ (def));
    const instance = await d.WrapperClass.init({ context: createStubContext() });
    assert.deepEqual(await instance.search('x', undefined, callContext()), [{ pluginEntryId: '7', title: 'Seven', confidence: 1, canonicalUrl: null }]);
    assert.deepEqual(await instance.getReadingList(callContext()), [], 'no mapping function: the client answer as is');
    const out = await instance.unsubscribe(['ok', 'bad'], callContext());
    assert.deepEqual(out.map((/** @type {any} */ r) => [r.pluginEntryId, r.success]), [['ok', true], ['bad', false]]);
});

test('an explicit binding overrides the convention, and a missing client call is named', async () => {
    const def = minimalDefinition({ mapping: {}, createClient: () => () => ({}) });
    def.methods = { search: async () => [] };
    const d = defineTrackerPlugin(/** @type {any} */ (def));
    const instance = await d.WrapperClass.init({ context: createStubContext() });
    assert.deepEqual(await instance.search('x', undefined, callContext()), []);
    await assert.rejects(instance.getReadingList(callContext()), /no 'getReadingList' source call/);
});
