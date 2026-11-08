'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sdk = require('../index.cjs');
const { createScopedCache } = require('../src/cache.cjs');
const { TokenCache } = require('../src/tokencache.cjs');
const { createStubCache } = require('../testing/index.cjs');

test('the contract version is the package version, and the catalog is closed at 21', () => {
    assert.equal(sdk.PLUGIN_CONTRACT_VERSION, require('../package.json').version);
    assert.equal(sdk.KNOWN_CAPABILITIES.length, 21);
    assert.equal(new Set(sdk.KNOWN_CAPABILITIES).size, 21);
});

test('the offer → method table covers every operation offer, sync.list and watch.list sharing one method', () => {
    for (const offer of sdk.OPERATION_OFFERS) assert.ok(sdk.OFFER_METHODS[offer], offer);
    assert.deepEqual(sdk.OFFER_METHODS['sync.list'], sdk.OFFER_METHODS['watch.list']);
    assert.deepEqual([...sdk.OFFER_METHODS['retrieve.chapterPages']], ['listPages', 'downloadPage']);
});

test('PluginError carries a brand, not a class identity, and only contract codes', () => {
    const e = new sdk.PluginError('rate_limited', 'slow down');
    assert.equal(sdk.isPluginError(e), true);
    const lookalike = Object.assign(new Error('x'), { code: 'rate_limited' });
    assert.equal(sdk.isPluginError(lookalike), false);
    const branded = Object.assign(new Error('x'), { code: 'offline', [Symbol.for('manga-list.PluginError')]: true });
    assert.equal(sdk.isPluginError(branded), true, 'a PluginError from another SDK copy is recognized');
    assert.throws(() => new sdk.PluginError('unauthorized', 'x'), /not a contract error code/);
});

test('perEntry: one result per entry, in order; a failure stays with its entry', async () => {
    const out = await sdk.perEntry(['a', 'b', 'c'], async (id) => {
        if (id === 'b') throw new sdk.PluginError('not_found', 'gone');
        return { value: id };
    });
    assert.deepEqual(out, [
        { value: 'a', pluginEntryId: 'a', success: true },
        { pluginEntryId: 'b', success: false, error: { code: 'not_found', message: 'gone' } },
        { value: 'c', pluginEntryId: 'c', success: true },
    ]);
    const plain = await sdk.perEntry([{ pluginEntryId: 'x' }], async () => { throw new Error('boom'); });
    assert.equal(plain[0].error?.code, 'source_error');
});

test('markCached and notFoundEntry give the contract\'s shapes', () => {
    assert.deepEqual(sdk.markCached({ pluginEntryId: '1' }, new Date(0)), { pluginEntryId: '1', cached: true, fetchedAt: '1970-01-01T00:00:00.000Z' });
    assert.deepEqual(sdk.notFoundEntry('1').error.code, 'not_found');
});

test('validators: a contract-shaped result has no problems; omitted nullable keys, linkState and comparison are named', () => {
    assert.deepEqual(sdk.validateResult('pullProgress', { pluginEntryId: '1', status: null, chapter: 3, rating: null, lastUpdated: null }), []);
    assert.match(sdk.validateResult('pullProgress', { pluginEntryId: '1', chapter: 3 }).join(' '), /'status' is missing/);
    assert.match(sdk.validateResult('summarizeEntries', [{ pluginEntryId: '1', success: true, summary: { label: null, status: null, latestChapter: null, lastUpdated: null, linkState: 'linked' } }]).join(' '), /linkState/);
    const listEntry = { pluginEntryId: '1', title: null, canonicalUrl: null, status: 'reading', chapter: null, rating: null, volume: null, listId: null, priority: null, lastUpdated: null };
    assert.deepEqual(sdk.validateResult('getReadingList', [listEntry]), []);
    assert.match(sdk.validateResult('getReadingList', [{ ...listEntry, comparison: {} }]).join(' '), /comparison/);
    const manifest = { syncOptions: { statusVocabulary: { pull: { reading: 'READING' } } } };
    assert.match(sdk.validateResult('getReadingList', [{ ...listEntry, status: 'READING' }], { manifest }).join(' '), /not a key of syncOptions.statusVocabulary.pull/);
});

test('validators: per-entry arrays are one per input, in order, with contract error codes', () => {
    const ok = [{ pluginEntryId: 'a', success: true }, { pluginEntryId: 'b', success: false, error: { code: 'not_found', message: 'x' } }];
    assert.deepEqual(sdk.validateResult('unsubscribe', ok, { inputIds: ['a', 'b'] }), []);
    assert.match(sdk.validateResult('unsubscribe', ok, { inputIds: ['a'] }).join(' '), /2 results for 1 entries/);
    assert.match(sdk.validateResult('unsubscribe', [{ pluginEntryId: 'a', success: false, error: { code: 'unauthorized', message: 'x' } }]).join(' '), /closed set/);
});

test('every §2 method a tracker binds has a validator', () => {
    const methods = new Set(Object.values(sdk.OFFER_METHODS).flat());
    for (const m of methods) assert.ok(sdk.VALIDATED_METHODS.includes(m), m);
});

test('the scoped cache keys by scope, and a null host cache is a miss, never an error', async () => {
    const host = createStubCache();
    const cache = createScopedCache(host);
    await cache.bind('user-a').set('list', [1]);
    await cache.bind('system').set('list', [2]);
    assert.deepEqual(await cache.bind('user-a').get('list'), [1]);
    assert.deepEqual(await cache.bind('system').get('list'), [2]);
    assert.deepEqual([...host.store.keys()].sort(), ['scope:system:list', 'scope:user-a:list']);
    const none = createScopedCache(null).bind('user-a');
    await none.set('k', 1);
    assert.equal(await none.get('k'), null);
    await assert.rejects(createScopedCache(host).bind('').get('k'), /no scope/);
});

test('the token cache: a set is usable while unexpired; an expired one is kept as previous', () => {
    let now = 1000;
    const tokens = new TokenCache({ now: () => now });
    tokens.set('a', { access: { value: 'x', expiresAt: 2000 }, refresh: { value: 'r' } });
    assert.ok(tokens.getUsable('a'));
    now = 3000;
    assert.equal(tokens.getUsable('a'), null);
    assert.equal(tokens.getAny('a')?.refresh.value, 'r');
    assert.equal(tokens.getUsable('b'), null);
});

test('the generic SettingsClass reads the document at settingsPath and overlays the user\'s saved values', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-settings-'));
    const file = path.join(dir, 'x-api-settings.json');
    fs.writeFileSync(file, JSON.stringify({ metadata: { componentName: 'XAPI', settingsContractVersion: '1.0.0' }, schema: { a: {} }, settings: { a: 1, b: 2 } }));
    const SettingsClass = sdk.createSettingsClass(null);
    const userSettingsService = {
        /** @param {number} userId @param {string} component @param {string} key */
        getUserSetting(userId, component, key) {
            return userId === 7 && component === 'XAPI' && key === 'b' ? { value: 20 } : null;
        },
    };
    const anonymous = await /** @type {any} */ (SettingsClass).init({ settingsPath: file });
    assert.deepEqual(anonymous.getAll(), { a: 1, b: 2 });
    const user = await /** @type {any} */ (SettingsClass).init({ settingsPath: file, userSettingsService, userId: 7 });
    assert.deepEqual(user.getAll(), { a: 1, b: 20 });
    assert.deepEqual(user.toLegacyFormat(), user.getAll());
    assert.equal(user.componentName, 'XAPI');
    assert.deepEqual(user.getSchema(), { a: {} });
    assert.equal(user.getMetadata().componentName, 'XAPI');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the SettingsClass refuses a document without its three sections or of another settings major', () => {
    assert.throws(() => sdk.createSettingsClass(/** @type {any} */ ({ metadata: { componentName: 'X' }, schema: {} })), /metadata, schema and settings/);
    assert.throws(() => sdk.createSettingsClass(/** @type {any} */ ({ metadata: { componentName: 'X', settingsContractVersion: '2.0.0' }, schema: {}, settings: {} })), /settingsContractVersion/);
});
