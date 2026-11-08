'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runConformance, createStubAxios, createStubContext, callContext } = require('../testing/index.cjs');
const fixture = require('./fixtures/throwaway.cjs');

test('the throwaway definition, every tracker offer bound, passes the runner with 0 failures', async () => {
    const axios = createStubAxios(fixture.sourceHandler);
    const report = await runConformance({
        WrapperClass: fixture.descriptor.WrapperClass,
        descriptor: fixture.descriptor,
        manifest: fixture.manifest,
        initOptions: { context: createStubContext({ axios }) },
        axios,
        context: () => callContext({ credential: { apiKey: 'good' } }),
    });
    assert.deepEqual(report.failed, []);
    assert.ok(report.passed.length >= 30, `ran ${report.passed.length} cases`);
});

test('the runner catches a hand-written class with a method outside the contract and a missing one', async () => {
    class Hand {
        static async init() { return new Hand(); }
        async initialize() { return { status: 'ok' }; }
        async getStatus() { return { status: 'ok' }; }
        async search() { return []; }
        async getSeriesUrl() { return ''; }
    }
    const manifest = { pluginName: 'hand', capabilities: ['search.query', 'search.lookup'] };
    const report = await runConformance({ WrapperClass: Hand, manifest });
    const ids = report.failed.map((f) => f.id);
    assert.ok(ids.includes('methods.declared-offers-have-methods'), 'lookup is missing');
    assert.ok(ids.includes('methods.none-outside-the-contract'), 'getSeriesUrl is outside');
    assert.ok(ids.includes('callContext.search-refuses-a-call-without-one'));
});
