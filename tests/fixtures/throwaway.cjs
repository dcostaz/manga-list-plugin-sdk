'use strict';

/**
 * A throwaway tracker: every tracker offer bound to a stub source through the three-layer shape
 * (client → mapping → bindings), so the facade, the HTTP layer and the runner are exercised end to end.
 * The stub source is the axios stub's handler: `sourceHandler(config)`.
 */

const { defineTrackerPlugin, perEntry, PluginError, isPluginError } = require('../../index.cjs');

const manifest = {
    pluginName: 'throwaway',
    displayName: 'Throwaway',
    pluginType: 'tracker',
    pluginContractVersion: '4.0.0',
    hostApiVersion: '1.0.0',
    capabilities: [
        'credential',
        'search.query', 'search.lookup',
        'enrich', 'enrich.cover',
        'sync.pull', 'sync.push', 'sync.list',
        'subscribe.add', 'subscribe.remove',
        'watch.entry', 'watch.list', 'watch.summary',
        'retrieve.chapterList', 'retrieve.chapterPages',
    ],
    entrypoints: { pluginModule: 'plugin-throwaway.cjs', settingsFile: 'throwaway-api-settings.json' },
    syncOptions: {
        statusVocabulary: {
            push: { READING: 'reading', COMPLETED: 'completed', PLAN_TO_READ: 'planned', ON_HOLD: 'paused', DROPPED: 'dropped', RE_READING: null },
            pull: { reading: 'READING', completed: 'COMPLETED', planned: 'PLAN_TO_READ', considering: 'PLAN_TO_READ', paused: 'ON_HOLD', dropped: 'DROPPED' },
        },
        progressAxes: { pull: ['chapter', 'rating'], push: ['chapter', { axis: 'rating', scale: 'integer' }] },
    },
    searchOptions: { requiresCredential: false },
    retrieveOptions: { requiresCredential: false },
    credentialOptions: { fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true }] },
};

const settings = {
    metadata: { componentName: 'ThrowawayAPI', settingsContractVersion: '1.0.0' },
    schema: {},
    settings: {
        'api.baseUrl': 'https://source.invalid/v1',
        'retry.enabled': true,
        'retry.maxAttempts': 2,
        'retry.backoff.initialDelay': 1,
        'retry.backoff.maxDelay': 5,
        'rateLimit.global.enabled': true,
        'rateLimit.global.maxConcurrent': 4,
        'rateLimit.global.queueSize': 50,
        'connection.timeout.request': 1000,
        'connection.timeout.search': 2000,
    },
};

/** Auth: the credential's API key is exchanged for a session token by POST /login. */
const auth = {
    /**
     * @param {any} credential
     * @param {{ http: any }} ctx
     */
    async exchange(credential, { http }) {
        const response = await http.post('/login', { apiKey: credential && credential.apiKey }, { endpoint: 'login' });
        return { tokens: { session: { value: String(response.data.session), expiresAt: Date.now() + 60000 } } };
    },
    /**
     * @param {Record<string, { value: string }>} tokens
     * @param {Record<string, any>} config
     */
    apply(tokens, config) {
        return { ...config, headers: { ...(config.headers || {}), Authorization: `Bearer ${tokens.session.value}` } };
    },
};

/** L4 — the client: source shapes in, source shapes out. */
/** @param {{ settings: Record<string, unknown> }} deps */
function createClient({ settings }) {
    const base = String(settings['api.baseUrl']);
    /** @param {any} view */
    return (view) => ({
        /** @param {string} q */
        search: async (q) => (await view.http.get(`${base}/series`, { params: { q }, endpoint: 'search', timeoutKind: 'search' })).data.results,
        /** @param {string} id */
        series: async (id) => (await view.http.get(`${base}/series/${id}`, { endpoint: 'series' })).data,
        library: async () => (await view.http.authedRequest({ method: 'get', url: `${base}/me/library`, endpoint: 'library' })).data.entries,
        /** @param {string} id */
        libraryEntry: async (id) => (await view.http.authedRequest({ method: 'get', url: `${base}/me/library/${id}`, endpoint: 'library' })).data,
        /** @param {string} id @param {Record<string, unknown>} body */
        putEntry: async (id, body) => (await view.http.authedRequest({ method: 'put', url: `${base}/me/library/${id}`, data: body, endpoint: 'library' })).data,
        /** @param {string} id */
        deleteEntry: async (id) => (await view.http.authedRequest({ method: 'delete', url: `${base}/me/library/${id}`, endpoint: 'library' })).data,
        /** @param {string} id */
        chapters: async (id) => (await view.http.get(`${base}/series/${id}/chapters`, { endpoint: 'chapters' })).data,
        /** @param {string} url */
        bytes: async (url) => Buffer.from((await view.http.get(url, { endpoint: 'image', responseType: 'arraybuffer' })).data || []),
    });
}

/** L3b — the mapping: pure. */
const map = {
    /** @param {any} s */
    candidate: (s) => ({ pluginEntryId: String(s.id), title: s.name, confidence: 0.9, canonicalUrl: `https://source.invalid/s/${s.id}` }),
    /** @param {any} s */
    contribution: (s) => ({ pluginEntryId: String(s.id), displayTitle: s.name, syncedAt: new Date(0).toISOString() }),
    /** @param {any} e */
    readingListEntry: (e) => ({
        pluginEntryId: String(e.id), title: e.name ?? null, canonicalUrl: null, status: e.state ?? null,
        chapter: e.chapter ?? null, rating: e.rating ?? null, volume: null, listId: null, priority: null, lastUpdated: null,
    }),
};

const descriptor = defineTrackerPlugin({
    manifest,
    settings,
    auth,
    createClient,
    methods: {
        search: async (view, query) => (await view.client.search(query)).map(map.candidate),
        lookup: async (view, id) => {
            const s = await view.client.series(id);
            return { ...map.contribution(s), canonicalUrl: `https://source.invalid/s/${s.id}` };
        },
        enrich: async (view, ids) => perEntry(ids, async (id) => ({ contribution: map.contribution(await view.client.series(id)) })),
        searchCovers: async (view, query) => [{ coverId: `cover-${query.title}`, imageUrl: 'https://source.invalid/c.jpg' }],
        downloadCover: async (view, coverId) => view.client.bytes(`https://source.invalid/covers/${coverId}`),
        pullProgress: async (view, id) => {
            const e = await view.client.libraryEntry(id);
            return { pluginEntryId: String(id), status: e.state ?? null, chapter: e.chapter ?? null, rating: e.rating ?? null, lastUpdated: null };
        },
        pushProgress: async (view, entries) => perEntry(entries, async (e) => {
            const out = await view.client.putEntry(e.pluginEntryId, { chapter: e.chapter, rating: e.rating });
            return { applied: { chapter: out.chapter, rating: out.rating } };
        }),
        getReadingList: async (view) => (await view.client.library()).map(map.readingListEntry),
        subscribe: async (view, entries) => perEntry(entries, async (e) => {
            const out = await view.client.putEntry(e.pluginEntryId, { state: e.status });
            return { listId: null, status: out.state ?? e.status };
        }),
        unsubscribe: async (view, ids) => perEntry(ids, async (id) => {
            try {
                await view.client.deleteEntry(id);
            } catch (error) {
                if (!(isPluginError(error) && error.code === 'not_found')) throw error; // already absent: idempotent (§2)
            }
            return {};
        }),
        queryLive: async (view, id) => {
            const s = await view.client.series(id);
            if (!s) throw new PluginError('not_found', 'no such series');
            return { status: 'ok', data: { pluginEntryId: String(id), fetchedAt: new Date(0).toISOString(), sections: [] } };
        },
        summarizeEntries: async (view, ids) => perEntry(ids, async (id) => {
            const s = await view.client.series(id);
            return { summary: { label: s.status ?? null, status: s.status ?? null, latestChapter: s.latest ?? null, lastUpdated: null } };
        }),
        listChapters: async (view, id) => ({
            chapters: (await view.client.chapters(id)).map((/** @type {any} */ c, /** @type {number} */ i) => ({ id: String(c.id), label: c.label, ordering: i, language: '' })),
            availableLanguages: [],
        }),
        listPages: async (view, id, chapterId) => [{ pageKey: `${chapterId}-p1`, pageNumber: 1 }],
        downloadPage: async (view, id, chapterId, pageKey) => view.client.bytes(`https://source.invalid/pages/${pageKey}`),
    },
});

/**
 * The stub source, answering the client's routes.
 * @param {Record<string, any>} config
 */
function sourceHandler(config) {
    const url = String(config.url || '');
    if (url.endsWith('/login')) {
        return config.data && config.data.apiKey === 'good' ? { status: 200, data: { session: 'session-good' } } : { status: 401, data: {} };
    }
    if (/\/me\//.test(url) && !(config.headers && /Bearer session-good/.test(config.headers.Authorization || ''))) {
        return { status: 401, data: {} };
    }
    if (url.endsWith('/series')) return { status: 200, data: { results: [{ id: 1, name: 'One' }] } };
    if (/\/series\/[^/]+\/chapters$/.test(url)) return { status: 200, data: [{ id: 'c1', label: 'Chapter 1' }] };
    if (/\/series\/[^/]+$/.test(url)) return { status: 200, data: { id: url.split('/').pop(), name: 'One', status: 'ongoing', latest: 10 } };
    if (url.endsWith('/me/library')) return { status: 200, data: { entries: [{ id: 1, name: 'One', state: 'reading', chapter: 3, rating: 8 }] } };
    if (/\/me\/library\/[^/]+$/.test(url)) {
        if (config.method === 'put') return { status: 200, data: { ...(config.data || {}), state: config.data && config.data.state } };
        if (config.method === 'delete') return { status: 204, data: null };
        return { status: 200, data: { state: 'reading', chapter: 3, rating: 8 } };
    }
    if (/covers|pages/.test(url)) return { status: 200, data: [1, 2, 3] };
    return { status: 404, data: {} };
}

module.exports = { descriptor, sourceHandler, manifest, settingsDocument: settings };
