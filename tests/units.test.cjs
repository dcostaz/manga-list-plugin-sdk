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
    const listEntry = { pluginEntryId: '1', title: null, canonicalUrl: null, status: 'reading', chapter: null, rating: null, volume: null, listId: null, priority: null, lastUpdated: null, altTitles: null };
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

test('every §2 method and own-data read has a validator; the transitional read has left the contract (A27)', () => {
    const methods = new Set([...Object.values(sdk.OFFER_METHODS).flat(), ...sdk.OWN_READ_METHODS]);
    assert.equal(/** @type {any} */ (sdk).TRANSITIONAL_READ_METHODS, undefined);
    for (const m of methods) assert.ok(sdk.VALIDATED_METHODS.includes(m), m);
});

test('a list entry carries altTitles from 4.2.0; a package built earlier is validated without it (A30)', () => {
    const entry = { pluginEntryId: '1', title: 'One', canonicalUrl: null, status: null, chapter: null, rating: null, volume: null, listId: null, priority: null, lastUpdated: null };
    const at = (/** @type {string} */ v) => ({ manifest: { pluginContractVersion: v } });
    assert.match(sdk.validateResult('getReadingList', [entry], at('4.2.0')).join(' '), /'altTitles' is missing/);
    assert.deepEqual(sdk.validateResult('getReadingList', [{ ...entry, altTitles: null }], at('4.2.0')), []);
    assert.deepEqual(sdk.validateResult('getReadingList', [{ ...entry, altTitles: ['Ichi'] }], at('4.2.0')), []);
    assert.match(sdk.validateResult('getReadingList', [{ ...entry, altTitles: [1] }], at('4.2.0')).join(' '), /string\[\] or null/);
    assert.deepEqual(sdk.validateResult('getReadingList', [entry], at('4.1.0')), []);
    assert.match(sdk.validateResult('getReadingList', [{ ...entry, altTitles: 'One' }], at('4.1.0')).join(' '), /string\[\] or null when present/);
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

test('A31: readThrough answers from the cache unless fresh, and says when the answer was fetched', async () => {
    const host = createStubCache();
    const cache = createScopedCache(host).bind('user-a');
    let fetches = 0;
    const fetch = async () => ({ title: `Solo ${++fetches}` });

    const first = await cache.readThrough('series:1', { ttlSeconds: 60 }, fetch);
    assert.deepEqual([first.value, first.cached], [{ title: 'Solo 1' }, false]);
    assert.match(String(first.fetchedAt), /^\d{4}-\d{2}-\d{2}T/);

    const again = await cache.readThrough('series:1', {}, fetch);
    assert.deepEqual([again.value, again.cached, again.fetchedAt], [{ title: 'Solo 1' }, true, first.fetchedAt]);

    const fresh = await cache.readThrough('series:1', { fresh: true }, fetch);
    assert.deepEqual([fresh.value, fresh.cached, fetches], [{ title: 'Solo 2' }, false, 2]);

    // A value cached before reads recorded their time is cached, its time unknown.
    await cache.set('series:2', { title: 'Old' });
    assert.deepEqual(await cache.readThrough('series:2', {}, fetch), { value: { title: 'Old' }, cached: true, fetchedAt: null });

    // No host cache: every read is the source's.
    const none = createScopedCache(null).bind('user-a');
    assert.equal((await none.readThrough('series:1', {}, fetch)).cached, false);
});

test('A31: an enrich contribution may say it was cached, and when it was fetched', () => {
    const ok = (/** @type {Record<string, unknown>} */ extra) => [{ pluginEntryId: '1', success: true, contribution: { pluginEntryId: '1', syncedAt: 'x', ...extra } }];
    assert.deepEqual(sdk.validateResult('enrich', ok({})), []);
    assert.deepEqual(sdk.validateResult('enrich', ok({ cached: true, fetchedAt: '2026-11-15T00:00:00.000Z' })), []);
    assert.match(sdk.validateResult('enrich', ok({ cached: 'yes' })).join(' '), /'cached' must be a boolean/);
    assert.match(sdk.validateResult('enrich', ok({ fetchedAt: 5 })).join(' '), /'fetchedAt' must be an ISO string/);
});

/** A full 4.4.0 candidate: its detail carries descriptive fields and a display part. */
function fullCandidate() {
    return {
        pluginEntryId: '7', title: 'Seven', altTitles: ['Sette'], confidence: 0.9, canonicalUrl: 'https://example.invalid/series/7',
        detail: {
            displayTitle: 'Seven', altTitles: ['Sette'], description: 'A series.', seriesStatus: 'cancelled', genres: ['Action'],
            authors: ['A. Writer', { name: 'B. Artist', type: 'art' }], year: 2017,
            display: {
                titles: [{ title: 'Seven', kind: 'main', language: 'en' }, { title: '七', kind: 'native', language: 'zh' }],
                descriptions: [{ text: 'A series.\nIn two lines.', language: 'en' }],
                cover: { sizes: [{ url: 'https://example.invalid/c/7.webp', width: 512 }], placeholder: { blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' } },
                contentRating: 'suggestive', statusText: 'Cancelled (2019)', dates: { started: '2017-01-01' },
                chapters: { latest: 120 }, tags: [{ name: 'Isekai', group: 'Theme', spoiler: true }],
                ratings: [{ source: 'Example', value: 7.5, scale: 10, votes: 120 }], popularity: { follows: 2297 },
                links: [{ label: 'Listed on Site B', url: 'https://site-b.invalid/series/7', type: 'site' }],
                site: { id: 'site-a', label: 'Site A', path: '/series/7' }, progress: { chapter: 118 },
                folder: { path: 'D:/manga/Seven', exists: true },
            },
        },
    };
}

test('4.4.0: the contract\'s vocabularies, and A36\'s result cap within 1–25', () => {
    assert.ok(sdk.SERIES_STATUSES.includes('cancelled'), 'A34');
    assert.deepEqual([...sdk.CONTENT_RATINGS], ['safe', 'suggestive', 'erotica', 'pornographic']);
    assert.equal(sdk.RESULT_CAP_SETTING, 'search.resultCap');
    assert.equal(sdk.resultCapOf({}), 25);
    assert.equal(sdk.resultCapOf(null), 25);
    assert.equal(sdk.resultCapOf({ 'search.resultCap': 10 }), 10);
    assert.equal(sdk.resultCapOf({ 'search.resultCap': 50 }), 25, 'never above the ceiling');
    assert.equal(sdk.resultCapOf({ 'search.resultCap': 0 }), 25, 'a cap below 1 is the default');
});

test('A32–A34: a candidate\'s detail, and its display part, validate when they are the contract\'s', () => {
    assert.deepEqual(sdk.validateResult('search', [fullCandidate()]), []);
    assert.deepEqual(sdk.validateResult('search', [{ pluginEntryId: '8', title: 'Thin', confidence: 1, canonicalUrl: null, detail: {} }]), [], 'a thin record');
    assert.deepEqual(sdk.validateResult('search', [{ pluginEntryId: '9', title: 'No detail', confidence: 1, canonicalUrl: null }]), [], 'a 4.3.0 candidate');
});

test('A32: detail never repeats the candidate\'s identity, and a field the source does not hold is absent', () => {
    const c = fullCandidate();
    Object.assign(c.detail, { pluginEntryId: '7', syncedAt: '2026-11-20T00:00:00.000Z' });
    const problems = sdk.validateResult('search', [c]).join(' ');
    assert.match(problems, /detail\.pluginEntryId: the candidate holds the record's identity/);
    assert.match(problems, /detail\.syncedAt: the candidate holds the record's identity/);
    const empty = fullCandidate();
    Object.assign(empty.detail, { description: '', genres: [] });
    Object.assign(empty.detail.display, { magazine: null });
    const emptyProblems = sdk.validateResult('search', [empty]).join(' ');
    assert.match(emptyProblems, /detail\.description: a field the source does not hold is absent/);
    assert.match(emptyProblems, /detail\.genres: a field the source does not hold is absent/);
    assert.match(emptyProblems, /display\.magazine: a field the source does not hold is absent/);
});

test('A33: the display part\'s vocabularies, a rating within its scale, and no field outside §2.6', () => {
    const c = fullCandidate();
    Object.assign(c.detail.display, {
        contentRating: 'adult',
        ratings: [{ source: 'Example', value: 12, scale: 10 }],
        titles: [{ title: 'Seven', kind: 'matched' }],
        mood: 'grim',
    });
    Object.assign(c.detail, { seriesStatus: 'paused' });
    const problems = sdk.validateResult('search', [c]).join(' ');
    assert.match(problems, /contentRating: 'adult' is not one of/);
    assert.match(problems, /ratings\[0\]\.value: must be a number within 0–scale/);
    assert.match(problems, /titles\[0\]\.kind: must be one of main, alternate, native, romanized/);
    assert.match(problems, /display\.mood: not a PluginEntryDisplay field/);
    assert.match(problems, /seriesStatus: 'paused' is not one of/);
});

test('A33: lookup answers its display part, validated the same way', () => {
    const detail = { pluginEntryId: '7', canonicalUrl: null, syncedAt: 'x', seriesStatus: 'cancelled', display: fullCandidate().detail.display };
    assert.deepEqual(sdk.validateResult('lookup', detail), []);
    assert.match(sdk.validateResult('lookup', { ...detail, display: { ratings: [{ source: 'x', value: 1, scale: 0 }] } }).join(' '), /scale: must be a number above 0/);
    assert.match(sdk.validateResult('lookup', { ...detail, seriesStatus: 'paused' }).join(' '), /lookup\.seriesStatus: 'paused'/);
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
