'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpRuntime, parseRetryAfter } = require('../src/http.cjs');
const { isPluginError, PluginError } = require('../src/errors.cjs');
const { createStubAxios } = require('../testing/index.cjs');

/** @param {Record<string, unknown>} [settings] */
const base = (settings = {}) => ({
    'retry.enabled': true,
    'retry.maxAttempts': 3,
    'retry.backoff.type': 'fixed',
    'retry.backoff.initialDelay': 1,
    'retry.backoff.maxDelay': 5,
    'rateLimit.global.enabled': false,
    ...settings,
});

/** @param {any} [credential] */
const bindArgs = (credential = { key: 'k' }) => ({ credential, identity: 'slot-a', scope: 'user-a', signal: null });

test('the request timeout comes from settings, the search timeout for a search call', async () => {
    const axios = createStubAxios();
    const http = createHttpRuntime({ axios, settings: base({ 'connection.timeout.request': 1234, 'connection.timeout.search': 5678 }) }).bind(bindArgs());
    await http.get('/a');
    await http.get('/b', { timeoutKind: 'search' });
    assert.equal(axios.calls[0].timeout, 1234);
    assert.equal(axios.calls[1].timeout, 5678);
});

test('a retryable 503 is retried up to maxAttempts, then is source_error', async () => {
    const axios = createStubAxios(() => ({ status: 503 }));
    const http = createHttpRuntime({ axios, settings: base() }).bind(bindArgs());
    await assert.rejects(http.get('/x'), (e) => isPluginError(e) && e.code === 'source_error' && e.status === 503);
    assert.equal(axios.calls.length, 3);
});

test('retry disabled means one attempt', async () => {
    const axios = createStubAxios(() => ({ status: 503 }));
    const http = createHttpRuntime({ axios, settings: base({ 'retry.enabled': false }) }).bind(bindArgs());
    await assert.rejects(http.get('/x'));
    assert.equal(axios.calls.length, 1);
});

test('429 waits Retry-After, then succeeds', async () => {
    let n = 0;
    const axios = createStubAxios(() => (n++ === 0 ? { status: 429, headers: { 'retry-after': '0.03' } } : { status: 200, data: 'ok' }));
    const http = createHttpRuntime({ axios, settings: base() }).bind(bindArgs());
    const started = Date.now();
    const res = await http.get('/x');
    assert.equal(res.data, 'ok');
    assert.ok(Date.now() - started >= 25, 'waited for Retry-After');
});

test('429 that never clears is rate_limited', async () => {
    const axios = createStubAxios(() => ({ status: 429, headers: { 'retry-after': '0' } }));
    const http = createHttpRuntime({ axios, settings: base() }).bind(bindArgs());
    await assert.rejects(http.get('/x'), (e) => isPluginError(e) && e.code === 'rate_limited');
});

test('404 is not_found and is not retried; 401 is credential_rejected', async () => {
    const a404 = createStubAxios(() => ({ status: 404 }));
    await assert.rejects(createHttpRuntime({ axios: a404, settings: base() }).bind(bindArgs()).get('/x'), (e) => isPluginError(e) && e.code === 'not_found');
    assert.equal(a404.calls.length, 1);
    const a401 = createStubAxios(() => ({ status: 401 }));
    await assert.rejects(createHttpRuntime({ axios: a401, settings: base() }).bind(bindArgs()).get('/x'), (e) => isPluginError(e) && e.code === 'credential_rejected');
});

test('a transport failure is offline after its retries', async () => {
    const axios = { calls: /** @type {any[]} */ ([]), async request(/** @type {any} */ c) { this.calls.push(c); const e = new Error('reset'); /** @type {any} */ (e).code = 'ECONNRESET'; throw e; } };
    const http = createHttpRuntime({ axios, settings: base() }).bind(bindArgs());
    await assert.rejects(http.get('/x'), (e) => isPluginError(e) && e.code === 'offline');
    assert.equal(axios.calls.length, 3);
});

test('the per-endpoint throttle spaces calls to one endpoint', async () => {
    const axios = createStubAxios();
    const http = createHttpRuntime({ axios, settings: base({ 'api.endpoints.feed.throttle': 40 }) }).bind(bindArgs());
    const started = Date.now();
    await http.get('/a', { endpoint: 'feed' });
    await http.get('/b', { endpoint: 'feed' });
    assert.ok(Date.now() - started >= 35, 'the second call waited for the throttle');
});

test('an aborted signal stops the call as offline, before the request', async () => {
    const axios = createStubAxios();
    const controller = new AbortController();
    controller.abort();
    const http = createHttpRuntime({ axios, settings: base() }).bind({ ...bindArgs(), signal: controller.signal });
    await assert.rejects(http.get('/x'), (e) => isPluginError(e) && e.code === 'offline');
    assert.equal(axios.calls.length, 0);
});

test('the signal aborts a throttle wait', async () => {
    const axios = createStubAxios();
    const controller = new AbortController();
    const http = createHttpRuntime({ axios, settings: base({ 'api.endpoints.feed.throttle': 5000 }) }).bind({ ...bindArgs(), signal: controller.signal });
    await http.get('/a', { endpoint: 'feed' });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(http.get('/b', { endpoint: 'feed' }), (e) => isPluginError(e) && e.code === 'offline');
});

test('the circuit opens after repeated source failures and refuses calls while open', async () => {
    const axios = createStubAxios(() => ({ status: 503 }));
    const http = createHttpRuntime({
        axios,
        settings: base({ 'retry.enabled': false, 'resilience.circuitBreaker.enabled': true, 'resilience.circuitBreaker.failureThreshold': 2, 'resilience.circuitBreaker.openDuration': 60000 }),
    }).bind(bindArgs());
    await assert.rejects(http.get('/x'));
    await assert.rejects(http.get('/x'));
    await assert.rejects(http.get('/x'), (e) => isPluginError(e) && e.code === 'offline' && /circuit/.test(e.message));
    assert.equal(axios.calls.length, 2);
});

test('the global limiter refuses beyond its queue', async () => {
    /** @type {Array<() => void>} */
    const holds = [];
    const axios = createStubAxios(() => new Promise((resolve) => holds.push(() => resolve({ status: 200 }))));
    const http = createHttpRuntime({ axios, settings: base({ 'rateLimit.global.enabled': true, 'rateLimit.global.maxConcurrent': 1, 'rateLimit.global.queueSize': 1 }) }).bind(bindArgs());
    const first = http.get('/1');
    const second = http.get('/2');
    await assert.rejects(http.get('/3'), (e) => isPluginError(e) && e.code === 'rate_limited');
    await new Promise((r) => setTimeout(r, 5));
    holds.shift()?.();
    await first;
    await new Promise((r) => setTimeout(r, 5));
    holds.shift()?.();
    await second;
});

test('authed: exchange once, apply per request, re-exchange once and replay once on a 401', async () => {
    let exchanges = 0;
    let firstUse = true;
    const auth = {
        async exchange() { exchanges += 1; return { tokens: { access: { value: `t${exchanges}` } } }; },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return { ...config, headers: { Authorization: tokens.access.value } }; },
    };
    const axios = createStubAxios((c) => {
        if (c.headers.Authorization === 't1' && firstUse) { firstUse = false; return { status: 401 }; }
        return { status: 200, data: c.headers.Authorization };
    });
    const runtime = createHttpRuntime({ axios, settings: base(), auth });
    const http = runtime.bind(bindArgs());
    const res = await http.authedRequest({ method: 'get', url: '/me' });
    assert.equal(res.data, 't2');
    assert.equal(exchanges, 2);
    const again = await http.authedRequest({ method: 'get', url: '/me' });
    assert.equal(again.data, 't2', 'the fresh token is reused');
    assert.equal(exchanges, 2);
});

test('authed: a second 401 after the replay is credential_rejected', async () => {
    const auth = {
        async exchange() { return { tokens: { access: { value: 't' } } }; },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return config; },
    };
    const axios = createStubAxios(() => ({ status: 401 }));
    const http = createHttpRuntime({ axios, settings: base(), auth }).bind(bindArgs());
    await assert.rejects(http.authedRequest({ url: '/me' }), (e) => isPluginError(e) && e.code === 'credential_rejected');
    assert.equal(axios.calls.length, 2, 'one call, one replay');
});

test('authed: an expired set is exchanged with the old set as previous (a refresh token survives)', async () => {
    /** @type {any[]} */
    const seen = [];
    let n = 0;
    const auth = {
        /** @param {any} cred @param {any} ctx */
        async exchange(cred, ctx) {
            seen.push([ctx.reason, ctx.previous && ctx.previous.refresh && ctx.previous.refresh.value]);
            n += 1;
            return { tokens: { access: { value: `a${n}`, expiresAt: n === 1 ? Date.now() - 1 : Date.now() + 60000 }, refresh: { value: 'r' } } };
        },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return config; },
    };
    const http = createHttpRuntime({ axios: createStubAxios(), settings: base(), auth }).bind(bindArgs());
    await http.authed(async () => 'one');
    await http.authed(async () => 'two');
    assert.deepEqual(seen, [['initial', null], ['expired', 'r']]);
});

test('authed: concurrent calls for one slot share one exchange', async () => {
    let exchanges = 0;
    const auth = {
        async exchange() { exchanges += 1; await new Promise((r) => setTimeout(r, 10)); return { tokens: { access: { value: 't' } } }; },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return config; },
    };
    const runtime = createHttpRuntime({ axios: createStubAxios(), settings: base(), auth });
    await Promise.all([runtime.bind(bindArgs()).authed(async () => 1), runtime.bind(bindArgs()).authed(async () => 2)]);
    assert.equal(exchanges, 1);
});

test('a normalizer turns a source\'s HTML body into a typed error; it never replays', async () => {
    const axios = createStubAxios(() => ({ status: 200, data: '<html>challenge</html>' }));
    const runtime = createHttpRuntime({ axios, settings: base() });
    runtime.addNormalizer((response) => {
        if (typeof response.data === 'string' && response.data.startsWith('<html')) throw new PluginError('offline', 'blocked by an interstitial');
    });
    await assert.rejects(runtime.bind(bindArgs()).get('/x'), (e) => isPluginError(e) && e.code === 'offline');
    assert.equal(axios.calls.length, 1);
});

test('no injected HTTP client is offline, named', async () => {
    const http = createHttpRuntime({ axios: null, settings: base() }).bind(bindArgs());
    await assert.rejects(http.get('/x'), /no HTTP client was injected/);
});

test('Retry-After parses seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('2', 0), 2000);
    assert.equal(parseRetryAfter(new Date(10000).toUTCString(), 4000), 6000);
    assert.equal(parseRetryAfter(undefined, 0), null);
});

// ── Phase 2: the operational settings change behaviour; the three auth shapes the trackers need ─────────

test('the configured timeout fires: a source slower than connection.timeout.request is offline after its retries', async () => {
    /** @type {number[]} */
    const timeouts = [];
    const axios = {
        calls: /** @type {any[]} */ ([]),
        /** @param {any} config */
        async request(config) {
            this.calls.push(config);
            timeouts.push(config.timeout);
            await new Promise((r) => setTimeout(r, config.timeout + 5));
            const e = new Error(`timeout of ${config.timeout}ms exceeded`);
            /** @type {any} */ (e).code = 'ECONNABORTED';
            throw e;
        },
    };
    const http = createHttpRuntime({ axios, settings: base({ 'connection.timeout.request': 15, 'retry.maxAttempts': 2 }) }).bind(bindArgs());
    await assert.rejects(http.get('/slow'), (e) => isPluginError(e) && e.code === 'offline');
    assert.deepEqual(timeouts, [15, 15]);
});

test('auth shape 1, a static key (MangaBaka): no exchange call, the key applied as a header', async () => {
    const auth = {
        /** @param {any} credential */
        async exchange(credential) { return { tokens: { key: { value: credential.apiKey } } }; },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return { ...config, headers: { 'x-api-key': tokens.key.value } }; },
    };
    const axios = createStubAxios((c) => ({ status: 200, data: c.headers['x-api-key'] }));
    const http = createHttpRuntime({ axios, settings: base(), auth }).bind(bindArgs({ apiKey: 'pat-1' }));
    assert.equal((await http.authedRequest({ url: '/me/library' })).data, 'pat-1');
    assert.equal(axios.calls.length, 1, 'no login call');
});

test('auth shape 2, password then refresh grants (MangaDex): refresh on expiry, password again when the refresh is refused', async () => {
    /** @type {string[]} */
    const grants = [];
    let now = 0;
    let accessCount = 0;
    const auth = {
        /** @param {any} credential @param {any} ctx */
        async exchange(credential, { http, previous, reason }) {
            const refresh = previous && previous.refresh ? previous.refresh.value : null;
            if (refresh && reason === 'expired') {
                try {
                    const r = await http.post('/auth/refresh', { grant_type: 'refresh_token', refresh_token: refresh }, { endpoint: 'refreshToken' });
                    grants.push('refresh');
                    return { tokens: { access: { value: r.data.access_token, expiresAt: Date.now() + 900000 }, refresh: { value: r.data.refresh_token } } };
                } catch {
                    // a refused refresh falls back to the password grant below
                }
            }
            const r = await http.post('/auth/token', { grant_type: 'password', username: credential.username, password: credential.password }, { endpoint: 'token' });
            grants.push('password');
            return { tokens: { access: { value: r.data.access_token, expiresAt: now }, refresh: { value: r.data.refresh_token } } };
        },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return { ...config, headers: { Authorization: `Bearer ${tokens.access.value}` } }; },
    };
    let refuseRefresh = false;
    const axios = createStubAxios((c) => {
        if (c.url === '/auth/token') return { status: 200, data: { access_token: `acc-${++accessCount}`, refresh_token: 'ref-1' } };
        if (c.url === '/auth/refresh') return refuseRefresh ? { status: 400 } : { status: 200, data: { access_token: `acc-${++accessCount}`, refresh_token: 'ref-2' } };
        return { status: 200, data: c.headers.Authorization };
    });
    const http = createHttpRuntime({ axios, settings: base({ 'retry.enabled': false }), auth }).bind(bindArgs({ username: 'u', password: 'p' }));
    now = Date.now() - 1; // the password grant's access token is already expired
    await http.authedRequest({ url: '/user/follows' });
    await http.authedRequest({ url: '/user/follows' });
    assert.deepEqual(grants, ['password', 'refresh']);
    refuseRefresh = true;
    const runtime2 = createHttpRuntime({ axios, settings: base({ 'retry.enabled': false }), auth });
    const http2 = runtime2.bind({ ...bindArgs({ username: 'u', password: 'p' }), identity: 'slot-b' });
    await http2.authedRequest({ url: '/user/follows' });
    await http2.authedRequest({ url: '/user/follows' });
    assert.deepEqual(grants.slice(2), ['password', 'password'], 'a refused refresh falls back to the password grant');
});

test('auth shape 3, a session login (MangaUpdates): one login per identity, a 401 re-logs in once and replays once', async () => {
    let logins = 0;
    let revoked = false;
    const auth = {
        /** @param {any} credential @param {any} ctx */
        async exchange(credential, { http }) {
            const r = await http.request({ method: 'put', url: '/account/login', data: { username: credential.username, password: credential.password }, endpoint: 'login' });
            logins += 1;
            return { tokens: { session: { value: r.data.context.session_token } } };
        },
        /** @param {any} tokens @param {any} config */
        apply(tokens, config) { return { ...config, headers: { Authorization: `Bearer ${tokens.session.value}` } }; },
    };
    const axios = createStubAxios((c) => {
        if (c.url === '/account/login') return { status: 200, data: { context: { session_token: `s-${logins + 1}` } } };
        if (revoked && c.headers.Authorization === 'Bearer s-1') return { status: 401 };
        return { status: 200, data: c.headers.Authorization };
    });
    const runtime = createHttpRuntime({ axios, settings: base(), auth });
    const http = runtime.bind(bindArgs({ username: 'u', password: 'p' }));
    assert.equal((await http.authedRequest({ url: '/lists' })).data, 'Bearer s-1');
    assert.equal((await http.authedRequest({ url: '/lists' })).data, 'Bearer s-1');
    assert.equal(logins, 1);
    revoked = true;
    assert.equal((await http.authedRequest({ url: '/lists' })).data, 'Bearer s-2');
    assert.equal(logins, 2);
    await runtime.bind({ ...bindArgs({ username: 'v', password: 'q' }), identity: 'slot-b' }).authedRequest({ url: '/lists' });
    assert.equal(logins, 3, 'another identity logs in on its own');
});
