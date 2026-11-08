'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runConformance, createStubAxios, createStubContext } = require('../testing/index.cjs');
const fixture = require('./fixtures/throwaway.cjs');

/** @param {{ failed: Array<{ id: string }> }} report */
const failedIds = (report) => report.failed.map((f) => f.id);

test('the throwaway definition, every tracker offer bound, passes every case with 0 failures', async () => {
    const axios = createStubAxios(fixture.sourceHandler);
    const report = await runConformance({
        WrapperClass: fixture.descriptor.WrapperClass,
        descriptor: fixture.descriptor,
        manifest: fixture.manifest,
        initOptions: { context: createStubContext({ axios }) },
        axios,
        credentials: [{ apiKey: 'good' }, { apiKey: 'good' }],
    });
    assert.deepEqual(report.failed, []);
    for (const id of [
        'F12.search.lookup.has-lookup',
        'IV.no-public-method-outside-the-contract',
        'result.pullProgress',
        'result.summarizeEntries',
        'status.returned-is-the-source-token',
        'status.subscribe-refuses-a-host-status',
        'F3.getReadingList-without-a-credential-is-rejected',
        'perEntry.unsubscribe-never-throws-for-the-batch',
        'unsubscribe.is-idempotent',
        'F11.no-identity-leaks-across-calls',
        'F11.cache-keys-name-the-scope',
    ]) {
        assert.ok(report.passed.includes(id), `ran and passed ${id}`);
    }
});

/**
 * A 3.x-style wrapper with the analysis's defects: a held credential, a list cache keyed by nothing,
 * the host status on the wire, a silent [] without a credential, a batch throw, a method outside the
 * contract, a declared offer with no method, and a synchronous getStatus.
 */
class Legacy {
    static async init(/** @type {any} */ options) {
        const instance = new Legacy();
        instance.http = options.httpClientFactory();
        instance.cache = options.context.cache;
        return instance;
    }
    /** @param {any} credential */
    setCredentials(credential) { this.credential = credential; }
    async initialize() { return { status: 'ok' }; }
    getStatus() { return { status: 'ok' }; }
    async search() { return [{ trackerId: '1', title: 'One', confidence: 90 }]; }
    async getReadingList() {
        if (!this.credential) return [];
        const cached = await this.cache.getValue('_library_list');
        if (cached) return cached;
        const login = await this.http.post('/login', { apiKey: this.credential.apiKey });
        await this.http.get('/me/library', { headers: { Authorization: login.data.token } });
        const list = [{ pluginEntryId: '1', title: null, canonicalUrl: null, status: 'READING', chapter: null, rating: null, volume: null, listId: null, priority: null, lastUpdated: null }];
        await this.cache.setValue('_library_list', list);
        return list;
    }
    async unsubscribe() { throw new Error('remove failed'); }
    compareProgress() { return {}; }
}
const legacyManifest = {
    pluginName: 'legacy',
    capabilities: ['credential', 'search.query', 'search.lookup', 'sync.list', 'subscribe.remove'],
    syncOptions: { statusVocabulary: { READING: 'reading', COMPLETED: 'completed', PLAN_TO_READ: 'planned', ON_HOLD: 'paused', DROPPED: 'dropped', RE_READING: null } },
};

test('the 3.x harness runs a legacy wrapper red, case by case, against the analysis\'s findings', async () => {
    const report = await runConformance({ WrapperClass: Legacy, manifest: legacyManifest, harness: '3.x' });
    const ids = failedIds(report);
    for (const expected of [
        'F12.search.lookup.has-lookup',
        'IV.no-public-method-outside-the-contract',
        'lifecycle.getStatus-is-cheap',
        'result.search',
        'status.returned-is-the-source-token',
        'F3.getReadingList-without-a-credential-is-rejected',
        'perEntry.unsubscribe-never-throws-for-the-batch',
        'F11.no-identity-leaks-across-calls',
        'F11.cache-keys-name-the-scope',
        'callContext.search-refuses-a-call-without-one',
    ]) {
        assert.ok(ids.includes(expected), `red: ${expected} (got ${ids.join(', ')})`);
    }
    assert.equal(report.failed.find((f) => f.id === 'harness.init'), undefined, 'the harness built it');
    const kinds = new Set(report.failed.map((f) => f.kind));
    assert.ok(kinds.has('structure') && kinds.has('shape') && kinds.has('behaviour'));
    assert.equal(report.failed.find((f) => f.id === 'F3.getReadingList-without-a-credential-is-rejected')?.finding, 'F3');
    assert.match(JSON.stringify(report.failed.find((f) => f.id === 'IV.no-public-method-outside-the-contract')), /compareProgress.*A13/);
});

test('a class whose init throws is one harness failure, and nothing else runs', async () => {
    class Broken { static async init() { throw new Error('needs a factory'); } }
    const report = await runConformance({ WrapperClass: Broken, manifest: { pluginName: 'b', capabilities: ['search.query'] } });
    assert.deepEqual(report.failed.map((f) => [f.id, f.kind]), [['F12.search.query.has-search', 'structure'], ['harness.init', 'harness']]);
});
