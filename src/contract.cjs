'use strict';

/**
 * The contract's constants, in one place: docs/plugins/host-capability-contract.md (4.0.0).
 *
 * The SDK's version IS the contract version (§1 header): a plugin's manifest names the SDK version it was
 * built against in `pluginContractVersion`, and the host compares majors and refuses a newer minor.
 *
 * This file replaces the `plugindtocontract.cjs` each plugin repo used to vendor (seven mirrors of one
 * constant). The host keeps its own constant until the standardization plan's Phase 5b re-points it here.
 */

const PLUGIN_CONTRACT_VERSION = '4.0.0';
const PLUGIN_SETTINGS_CONTRACT_VERSION = '1.0.0';

// §1.1 Access offers — exactly one applies per plugin.
const CAPABILITY_CREDENTIAL = 'credential';
const CAPABILITY_FILE_PATH = 'file-path';

// §1.2 Operation offers — each maps to exactly one governed domain.
const CAPABILITY_SEARCH_QUERY = 'search.query';
const CAPABILITY_SEARCH_LOOKUP = 'search.lookup';
const CAPABILITY_ENRICH = 'enrich';
const CAPABILITY_ENRICH_COVER = 'enrich.cover';
const CAPABILITY_SYNC_PULL = 'sync.pull';
const CAPABILITY_SYNC_PUSH = 'sync.push';
const CAPABILITY_SYNC_LIST = 'sync.list';
const CAPABILITY_SUBSCRIBE_ADD = 'subscribe.add';
const CAPABILITY_SUBSCRIBE_REMOVE = 'subscribe.remove';
const CAPABILITY_WATCH_ENTRY = 'watch.entry';
const CAPABILITY_WATCH_LIST = 'watch.list';
const CAPABILITY_WATCH_SUMMARY = 'watch.summary';
const CAPABILITY_RETRIEVE_CHAPTER_LIST = 'retrieve.chapterList';
const CAPABILITY_RETRIEVE_CHAPTER_PAGES = 'retrieve.chapterPages';

// §1.3 Presentation facts.
const CAPABILITY_WORKSPACE_EXISTS = 'workspace.exists';
const CAPABILITY_WORKSPACE_LAYOUT = 'workspace.layout';
const CAPABILITY_WORKSPACE_CALLBACKS = 'workspace.callbacks';
const CAPABILITY_WORKSPACE_COMPONENTS = 'workspace.components';
const CAPABILITY_FILTERABLE = 'filterable';

const ACCESS_OFFERS = Object.freeze([CAPABILITY_CREDENTIAL, CAPABILITY_FILE_PATH]);

const OPERATION_OFFERS = Object.freeze([
    CAPABILITY_SEARCH_QUERY, CAPABILITY_SEARCH_LOOKUP,
    CAPABILITY_ENRICH, CAPABILITY_ENRICH_COVER,
    CAPABILITY_SYNC_PULL, CAPABILITY_SYNC_PUSH, CAPABILITY_SYNC_LIST,
    CAPABILITY_SUBSCRIBE_ADD, CAPABILITY_SUBSCRIBE_REMOVE,
    CAPABILITY_WATCH_ENTRY, CAPABILITY_WATCH_LIST, CAPABILITY_WATCH_SUMMARY,
    CAPABILITY_RETRIEVE_CHAPTER_LIST, CAPABILITY_RETRIEVE_CHAPTER_PAGES,
]);

const PRESENTATION_FACTS = Object.freeze([
    CAPABILITY_WORKSPACE_EXISTS, CAPABILITY_WORKSPACE_LAYOUT,
    CAPABILITY_WORKSPACE_CALLBACKS, CAPABILITY_WORKSPACE_COMPONENTS,
    CAPABILITY_FILTERABLE,
]);

/** The closed catalog (§1): 2 + 14 + 5 = 21 strings. */
const KNOWN_CAPABILITIES = Object.freeze([...ACCESS_OFFERS, ...OPERATION_OFFERS, ...PRESENTATION_FACTS]);

/**
 * §2's offer → method table, for the offers a tracker binds. Two offers may share one method
 * (`sync.list`/`watch.list` → `getReadingList`): the plugin binds the method once and never knows which
 * offer called. `filterable` belongs to the adapter plan's runtime and is not bound here.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const OFFER_METHODS = Object.freeze({
    [CAPABILITY_CREDENTIAL]: Object.freeze(['testCredentials']),
    [CAPABILITY_SEARCH_QUERY]: Object.freeze(['search']),
    [CAPABILITY_SEARCH_LOOKUP]: Object.freeze(['lookup']),
    [CAPABILITY_ENRICH]: Object.freeze(['enrich']),
    [CAPABILITY_ENRICH_COVER]: Object.freeze(['searchCovers', 'downloadCover']),
    [CAPABILITY_SYNC_PULL]: Object.freeze(['pullProgress']),
    [CAPABILITY_SYNC_PUSH]: Object.freeze(['pushProgress']),
    [CAPABILITY_SYNC_LIST]: Object.freeze(['getReadingList']),
    [CAPABILITY_SUBSCRIBE_ADD]: Object.freeze(['subscribe']),
    [CAPABILITY_SUBSCRIBE_REMOVE]: Object.freeze(['unsubscribe']),
    [CAPABILITY_WATCH_ENTRY]: Object.freeze(['queryLive']),
    [CAPABILITY_WATCH_LIST]: Object.freeze(['getReadingList']),
    [CAPABILITY_WATCH_SUMMARY]: Object.freeze(['summarizeEntries']),
    [CAPABILITY_RETRIEVE_CHAPTER_LIST]: Object.freeze(['listChapters']),
    [CAPABILITY_RETRIEVE_CHAPTER_PAGES]: Object.freeze(['listPages', 'downloadPage']),
});

/**
 * Each operation offer's governed domain (§1.2), and each domain's credential side (§2.5).
 * @type {Readonly<Record<string, string>>}
 */
const OFFER_DOMAIN = Object.freeze({
    [CAPABILITY_SEARCH_QUERY]: 'Searching',
    [CAPABILITY_SEARCH_LOOKUP]: 'Searching',
    [CAPABILITY_ENRICH]: 'Enriching',
    [CAPABILITY_ENRICH_COVER]: 'Enriching',
    [CAPABILITY_SYNC_PULL]: 'Syncing',
    [CAPABILITY_SYNC_PUSH]: 'Syncing',
    [CAPABILITY_SYNC_LIST]: 'Syncing',
    [CAPABILITY_SUBSCRIBE_ADD]: 'Subscribing',
    [CAPABILITY_SUBSCRIBE_REMOVE]: 'Subscribing',
    [CAPABILITY_WATCH_ENTRY]: 'Watching',
    [CAPABILITY_WATCH_LIST]: 'Watching',
    [CAPABILITY_WATCH_SUMMARY]: 'Watching',
    [CAPABILITY_RETRIEVE_CHAPTER_LIST]: 'Retrieving',
    [CAPABILITY_RETRIEVE_CHAPTER_PAGES]: 'Retrieving',
});

/** @type {Readonly<Record<string, 'system' | 'user'>>} */
const DOMAIN_SIDE = Object.freeze({
    Searching: 'system',
    Enriching: 'system',
    Watching: 'system',
    Syncing: 'user',
    Subscribing: 'user',
    Retrieving: 'user',
});

/** The host's reading statuses — the keys of `statusVocabulary.push` (§2.2). */
const HOST_READING_STATUSES = Object.freeze(['READING', 'COMPLETED', 'PLAN_TO_READ', 'ON_HOLD', 'DROPPED', 'RE_READING']);

/** §2.2's closed progress-axis catalog, and the scales an axis may declare. */
const PROGRESS_AXIS_CATALOG = Object.freeze(['chapter', 'rating']);
const PROGRESS_AXIS_SCALES = Object.freeze(['integer', 'decimal']);

/**
 * Thrown by `queryFilter()` when no field in the spec matches the plugin's filterSchema; the host treats
 * the filter as pass-through. Kept for the adapter runtime.
 */
class FilterNotApplicableError extends Error {
    /** @param {string} [message] */
    constructor(message) {
        super(message || 'No filter spec fields match this plugin\'s filterSchema');
        this.name = 'FilterNotApplicableError';
    }
}

module.exports = {
    PLUGIN_CONTRACT_VERSION,
    PLUGIN_SETTINGS_CONTRACT_VERSION,

    CAPABILITY_CREDENTIAL,
    CAPABILITY_FILE_PATH,
    CAPABILITY_SEARCH_QUERY,
    CAPABILITY_SEARCH_LOOKUP,
    CAPABILITY_ENRICH,
    CAPABILITY_ENRICH_COVER,
    CAPABILITY_SYNC_PULL,
    CAPABILITY_SYNC_PUSH,
    CAPABILITY_SYNC_LIST,
    CAPABILITY_SUBSCRIBE_ADD,
    CAPABILITY_SUBSCRIBE_REMOVE,
    CAPABILITY_WATCH_ENTRY,
    CAPABILITY_WATCH_LIST,
    CAPABILITY_WATCH_SUMMARY,
    CAPABILITY_RETRIEVE_CHAPTER_LIST,
    CAPABILITY_RETRIEVE_CHAPTER_PAGES,
    CAPABILITY_WORKSPACE_EXISTS,
    CAPABILITY_WORKSPACE_LAYOUT,
    CAPABILITY_WORKSPACE_CALLBACKS,
    CAPABILITY_WORKSPACE_COMPONENTS,
    CAPABILITY_FILTERABLE,

    ACCESS_OFFERS,
    OPERATION_OFFERS,
    PRESENTATION_FACTS,
    KNOWN_CAPABILITIES,
    OFFER_METHODS,
    OFFER_DOMAIN,
    DOMAIN_SIDE,
    HOST_READING_STATUSES,
    PROGRESS_AXIS_CATALOG,
    PROGRESS_AXIS_SCALES,

    FilterNotApplicableError,
};
