'use strict';

/**
 * A throwaway adapter: a `file-path` plugin over one JSON file (its "library"), declaring the offers an adapter
 * typically has, `filterable` and a `workspace.entry` block, so the adapter parts of the definition and the
 * runner's A19–A25 cases are exercised end to end. Its path arrives in each call's grant (`view.paths.libraryPath`).
 */

const fs = require('fs').promises;
const path = require('path');
const { definePlugin, perEntry, notFoundEntry, PluginError } = require('../../index.cjs');

const manifest = {
    pluginName: 'throwaway-adapter',
    displayName: 'Throwaway Adapter',
    pluginType: 'adapter',
    pluginContractVersion: '4.1.0',
    hostApiVersion: '1.0.0',
    capabilities: ['file-path', 'search.query', 'enrich', 'sync.list', 'watch.list', 'watch.summary', 'filterable'],
    entrypoints: { pluginModule: 'plugin-throwaway-adapter.cjs', settingsFile: 'throwaway-adapter-settings.json' },
    filePathOptions: { fields: [{ key: 'libraryPath', label: 'Library file', kind: 'file' }] },
    filterSchema: { seriesStatus: { type: 'enum', values: ['ongoing', 'completed'], label: 'Series status' } },
    syncOptions: { statusVocabulary: { push: {}, pull: {} }, progressAxes: { pull: ['chapter'], push: [] } },
    workspace: { workspaceId: 'plugin:throwaway-adapter', entry: 'web/index.html' },
};

const settings = {
    metadata: { componentName: 'ThrowawayAdapterSettings', settingsContractVersion: '1.0.0' },
    schema: { libraryPath: { type: 'string', label: 'Library file' } },
    settings: { libraryPath: '' },
};

/** The fixture library the grant points at. */
const LIBRARY_PATH = path.join(__dirname, 'throwaway-adapter-library.json');

/**
 * Read the library; an unreadable file is source_error, never an empty library (A25).
 * @param {{ paths: Record<string, string> | null }} view
 * @returns {Promise<Array<{ id: string, title: string, altTitles: string[], chapter: number | null, seriesStatus: string }>>}
 */
async function readLibrary(view) {
    const file = view.paths ? view.paths.libraryPath : '';
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
        throw new PluginError('source_error', `the library at ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const descriptor = definePlugin({
    manifest,
    settings,
    createClient: () => () => ({}),
    methods: {
        async search(view, query) {
            const q = String(query || '').toLowerCase();
            return (await readLibrary(view))
                .filter((e) => e.title.toLowerCase().includes(q))
                .map((e) => ({ pluginEntryId: e.id, title: e.title, confidence: 1, canonicalUrl: null }));
        },
        async enrich(view, ids) {
            const library = await readLibrary(view);
            return perEntry(ids, async (id) => {
                const e = library.find((x) => x.id === id);
                if (!e) throw new PluginError('not_found', `no entry '${id}'`);
                return { contribution: { title: e.title, altTitles: e.altTitles } };
            });
        },
        async getReadingList(view) {
            return (await readLibrary(view)).map((e) => ({
                pluginEntryId: e.id, title: e.title, canonicalUrl: null, status: null, chapter: e.chapter,
                rating: null, volume: null, listId: null, priority: null, lastUpdated: null,
            }));
        },
        async summarizeEntries(view, ids) {
            const library = await readLibrary(view);
            return ids.map((id) => {
                const e = library.find((x) => x.id === id);
                return e
                    ? { pluginEntryId: id, success: true, summary: { label: e.seriesStatus, status: e.seriesStatus, latestChapter: e.chapter, lastUpdated: null } }
                    : notFoundEntry(id);
            });
        },
        async queryFilter(view, spec) {
            const wanted = spec.fields.seriesStatus;
            return (await readLibrary(view)).filter((e) => e.seriesStatus === wanted).map((e) => e.id);
        },
        async listEntries(view, _filters, pagination) {
            const library = await readLibrary(view);
            const page = (pagination && pagination.page) || 1;
            const pageSize = (pagination && pagination.pageSize) || 50;
            const entries = library.slice((page - 1) * pageSize, page * pageSize)
                .map((e) => ({ pluginEntryId: e.id, title: e.title, altTitles: e.altTitles, seriesStatus: e.seriesStatus }));
            return { entries, totalCount: library.length, page, pageSize };
        },
        async getEntry(view, id) {
            const e = (await readLibrary(view)).find((x) => x.id === id);
            if (!e) throw new PluginError('not_found', `no entry '${id}'`);
            return { pluginEntryId: e.id, title: e.title, altTitles: e.altTitles, seriesStatus: e.seriesStatus };
        },
    },
});

module.exports = { manifest, settings, descriptor, LIBRARY_PATH, grant: { libraryPath: LIBRARY_PATH } };
