'use strict';

/**
 * The definition's adapter parts (adapter plan Phase 1; contract 4.1.0, A17–A25): one definition for every
 * plugin type, the path grant per call, `filterable`, the own-data reads, the transitional read, and the
 * runner's adapter cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../index.cjs');
const { definePlugin, defineAdapterPlugin, defineTrackerPlugin, isPluginError, PluginError } = sdk;
const { runConformance, createStubContext, callContext } = require('../testing/index.cjs');
const fixture = require('./fixtures/throwaway-adapter.cjs');

/** @param {Record<string, any>} [overrides] */
function adapterDefinition(overrides = {}) {
    const base = {
        manifest: JSON.parse(JSON.stringify(fixture.manifest)),
        settings: fixture.settings,
        createClient: () => () => ({}),
        methods: {},
    };
    return { ...base, ...overrides };
}

/** The fixture's bindings, every one. */
const bindings = () => /** @type {any} */ ({
    search: async () => [], enrich: async () => [], getReadingList: async () => [], summarizeEntries: async () => [],
    queryFilter: async () => [], listEntries: async () => ({ entries: [], totalCount: 0, page: 1, pageSize: 10 }), getEntry: async () => null,
});

const grantCtx = (/** @type {Record<string, any>} */ overrides = {}) => callContext({ credential: fixture.grant, identity: 'system-label', scope: 'system', ...overrides });

async function instance() {
    return fixture.descriptor.WrapperClass.init({ context: createStubContext() });
}

test('one definition: the two names are aliases of definePlugin', () => {
    assert.equal(defineAdapterPlugin, definePlugin);
    assert.equal(defineTrackerPlugin, definePlugin);
});

test('an adapter built for 4.0 is refused (A17)', () => {
    const def = adapterDefinition({ methods: bindings() });
    def.manifest.pluginContractVersion = '4.0.0';
    assert.throws(() => definePlugin(def), /4\.1\.0 or later \(A17\)/);
});

test('exactly one access offer applies (§1.1)', () => {
    const none = adapterDefinition({ methods: bindings() });
    none.manifest.capabilities = none.manifest.capabilities.filter((/** @type {string} */ c) => c !== 'file-path');
    assert.throws(() => definePlugin(none), /exactly one access offer/);
});

test('a file-path plugin declares its path settings, a filterable one its schema (§1.4)', () => {
    const noPaths = adapterDefinition({ methods: bindings() });
    delete noPaths.manifest.filePathOptions;
    assert.throws(() => definePlugin(noPaths), /filePathOptions\.fields/);
    const noSchema = adapterDefinition({ methods: bindings() });
    delete noSchema.manifest.filterSchema;
    assert.throws(() => definePlugin(noSchema), /filterSchema/);
});

test('a workspace.entry block requires the two own-data reads (§5.4)', () => {
    const b = bindings();
    delete b.getEntry;
    assert.throws(() => definePlugin(adapterDefinition({ methods: b })), /'getEntry' with no binding/);
});

test('the transitional read may be bound; any other extra method may not (A23)', () => {
    const withBatch = definePlugin(adapterDefinition({ methods: { ...bindings(), pullProgressBatch: async () => [] } }));
    assert.equal(typeof withBatch.WrapperClass.prototype.pullProgressBatch, 'function');
    assert.throws(() => definePlugin(adapterDefinition({ methods: { ...bindings(), findMatches: async () => [] } })), /'findMatches' serves no declared offer/);
});

test('the path grant arrives per call; a call without it is a host_contract_violation (A19)', async () => {
    const inst = await instance();
    const list = await inst.getReadingList(grantCtx());
    assert.equal(list.length, 2);
    await assert.rejects(inst.getReadingList(grantCtx({ credential: null })), (e) => isPluginError(e) && e.code === 'host_contract_violation');
    await assert.rejects(inst.getReadingList(grantCtx({ credential: { libraryPath: 'relative/path.json' } })), /absolute path/);
});

test('the path settings are never in what the plugin sees (A19)', async () => {
    /** @type {Record<string, unknown> | null} */
    let seen = null;
    const d = definePlugin(adapterDefinition({
        createClient: (/** @type {any} */ deps) => { seen = deps.settings; return () => ({}); },
        methods: bindings(),
    }));
    await d.WrapperClass.init({ context: createStubContext(), serviceSettings: { libraryPath: '/somewhere/lib.json', other: 1 } });
    assert.deepEqual(seen, { other: 1 });
});

test('context.sqlite reaches createClient and the view (A24)', async () => {
    const sqlite = function FakeDatabase() {};
    /** @type {any} */
    let fromDeps = null;
    /** @type {any} */
    let fromView = null;
    const b = bindings();
    b.getReadingList = async (/** @type {any} */ view) => { fromView = view.sqlite; return []; };
    const d = definePlugin(adapterDefinition({ createClient: (/** @type {any} */ deps) => { fromDeps = deps.sqlite; return () => ({}); }, methods: b }));
    const inst = await d.WrapperClass.init({ context: { ...createStubContext(), sqlite } });
    await inst.getReadingList(grantCtx());
    assert.equal(fromDeps, sqlite);
    assert.equal(fromView, sqlite);
});

test('queryFilter answers PluginFilterResult; a spec naming no schema field is not applicable, unbound (A21)', async () => {
    let calls = 0;
    const b = bindings();
    b.queryFilter = async () => { calls += 1; return ['entry-1']; };
    const inst = await definePlugin(adapterDefinition({ methods: b })).WrapperClass.init({ context: createStubContext() });
    assert.deepEqual(await inst.queryFilter({ fields: { seriesStatus: 'ongoing' } }, grantCtx()), { applicable: true, pluginEntryIds: ['entry-1'] });
    assert.deepEqual(await inst.queryFilter({ fields: { nope: 'x' } }, grantCtx()), { applicable: false, pluginEntryIds: [] });
    assert.deepEqual(await inst.queryFilter({ fields: { seriesStatus: '' } }, grantCtx()), { applicable: false, pluginEntryIds: [] });
    assert.equal(calls, 1);
});

test('getEntry answers null for an id the plugin does not know (§5.4)', async () => {
    const inst = await instance();
    assert.equal(await inst.getEntry('nope', grantCtx()), null);
    assert.equal((await inst.getEntry('entry-1', grantCtx())).title, 'A Title');
});

test('an unreadable source throws source_error, and a batch fails per entry (A25)', async () => {
    const inst = await instance();
    const missing = grantCtx({ credential: { libraryPath: fixture.LIBRARY_PATH + '.missing' } });
    await assert.rejects(inst.getReadingList(missing), (e) => isPluginError(e) && e.code === 'source_error');
    const out = await inst.summarizeEntries(['entry-1'], missing);
    assert.equal(out[0].success, false);
    assert.equal(out[0].error.code, 'source_error');
});

test('the validators know the 4.1 shapes', () => {
    assert.deepEqual(sdk.validateResult('queryFilter', { applicable: true, pluginEntryIds: ['1'] }), []);
    assert.equal(sdk.validateResult('queryFilter', ['1']).length, 1);
    assert.equal(sdk.validateResult('queryFilter', { applicable: false, pluginEntryIds: ['1'] }).length, 1);
    assert.deepEqual(sdk.validateResult('listEntries', { entries: [{ pluginEntryId: '1', title: 'T', anything: 1 }], totalCount: 1, page: 1, pageSize: 10 }), []);
    assert.ok(sdk.validateResult('listEntries', { items: [], totalCount: 0 }).length >= 2);
    assert.deepEqual(sdk.validateResult('getEntry', null), []);
    assert.equal(sdk.validateResult('getEntry', { pluginEntryId: '1' }).length, 1);
});

test('the throwaway adapter passes every case, the adapter cases among them', async () => {
    const report = await runConformance({
        WrapperClass: fixture.descriptor.WrapperClass,
        descriptor: fixture.descriptor,
        manifest: fixture.manifest,
        credentials: [fixture.grant, fixture.grant],
    });
    assert.deepEqual(report.failed, []);
    for (const id of [
        'A19.search-refuses-a-call-without-its-path-grant',
        'A25.getReadingList-never-answers-an-unreadable-source-empty',
        'A25.listEntries-never-answers-an-unreadable-source-empty',
        'A25.queryFilter-never-answers-an-unreadable-source-empty',
        'A4.summarizeEntries-unknown-entry-is-not_found',
        'A21.a-filter-naming-no-schema-field-is-not-applicable',
        'own.getEntry-unknown-id-is-null',
        'result.listEntries',
        'perEntry.enrich-never-throws-for-the-batch',
    ]) {
        assert.ok(report.passed.includes(id), `ran and passed ${id}`);
    }
});

/** A hand-built 4.0-style adapter: holds its path from settings, answers [] for a missing file, throws a class for "not applicable". */
class LegacyAdapter {
    static async init() { return new LegacyAdapter(); }
    async initialize() { return { status: 'ok' }; }
    async getStatus() { return { status: 'ok' }; }
    async search() { return []; }
    async enrich(/** @type {string[]} */ ids) { return ids.map((id) => ({ pluginEntryId: id, success: false, error: 'not found' })); }
    async getReadingList() { return []; }
    async summarizeEntries(/** @type {string[]} */ ids) { return ids.map((id) => ({ pluginEntryId: id, success: true, summary: { linkState: 'error' } })); }
    async queryFilter() { throw new Error('FilterNotApplicableError'); }
    async listEntries() { return { items: [], totalCount: 0 }; }
    async getEntry() { return {}; }
    async findMatches() { return []; }
}

test('a 4.0-style adapter runs red against A19, A21, A25 and the own-read shapes', async () => {
    const report = await runConformance({ WrapperClass: LegacyAdapter, manifest: fixture.manifest, credentials: [fixture.grant, fixture.grant] });
    const ids = report.failed.map((f) => f.id);
    for (const expected of [
        'IV.no-public-method-outside-the-contract',
        'A19.search-refuses-a-call-without-its-path-grant',
        'A25.getReadingList-never-answers-an-unreadable-source-empty',
        'A25.search-never-answers-an-unreadable-source-empty',
        'A4.summarizeEntries-unknown-entry-is-not_found',
        'A21.a-filter-naming-no-schema-field-is-not-applicable',
        'result.listEntries',
        'result.summarizeEntries',
        'own.getEntry-unknown-id-is-null',
    ]) {
        assert.ok(ids.includes(expected), `red: ${expected} (got ${ids.join(', ')})`);
    }
});

test('PluginError survives as the error type the adapter cases expect', () => {
    assert.ok(isPluginError(new PluginError('source_error', 'x')));
});
