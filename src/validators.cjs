'use strict';

/**
 * DTO validators for every §2 result shape (contract §2.6 and the typedefs it names). One function,
 * `validateResult(method, result, options)`, returns the list of problems — empty when the result is the
 * contract's. The host's Dispatching delegate runs the same validators on what a plugin returns
 * (`contract_violation`), and the conformance runner runs them on every bound method.
 */

const { PLUGIN_ERROR_CODES } = require('./errors.cjs');

/** @typedef {{ manifest?: { syncOptions?: any } | null, inputIds?: string[] | null }} ValidateOptions */

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isRecord(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {'string' | 'number'} type
 * @param {string} where
 * @param {string[]} problems
 */
function nullableField(obj, key, type, where, problems) {
    if (!(key in obj)) {
        problems.push(`${where}: '${key}' is missing (null is the contracted answer for "no such thing", never an omitted key)`);
        return;
    }
    const value = obj[key];
    if (value !== null && typeof value !== type) {
        problems.push(`${where}: '${key}' must be ${type} or null`);
    }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string} where
 * @param {string[]} problems
 */
function requiredString(obj, key, where, problems) {
    if (typeof obj[key] !== 'string' || !obj[key]) {
        problems.push(`${where}: '${key}' must be a non-empty string`);
    }
}

/**
 * @param {unknown} error
 * @param {string} where
 * @param {string[]} problems
 */
function entryError(error, where, problems) {
    if (!isRecord(error)) {
        problems.push(`${where}: a failed entry carries 'error: { code, message }'`);
        return;
    }
    if (!PLUGIN_ERROR_CODES.includes(/** @type {string} */ (error.code))) {
        problems.push(`${where}: error.code '${String(error.code)}' is not in the plugin's closed set (${PLUGIN_ERROR_CODES.join(', ')})`);
    }
    if (typeof error.message !== 'string') {
        problems.push(`${where}: error.message must be a string`);
    }
}

/**
 * Per-entry array results (§2.1): one element per input, in order, each `{ pluginEntryId, success, error? }`.
 * @param {unknown} result
 * @param {string} method
 * @param {ValidateOptions} options
 * @param {(entry: Record<string, unknown>, where: string, problems: string[]) => void} onSuccess
 * @returns {string[]}
 */
function perEntryArray(result, method, options, onSuccess) {
    /** @type {string[]} */
    const problems = [];
    if (!Array.isArray(result)) {
        return [`${method}: must return an array (array in, array out, §2.1)`];
    }
    if (Array.isArray(options.inputIds) && result.length !== options.inputIds.length) {
        problems.push(`${method}: returned ${result.length} results for ${options.inputIds.length} entries (one per entry, §2.1)`);
    }
    result.forEach((entry, index) => {
        const where = `${method}[${index}]`;
        if (!isRecord(entry)) {
            problems.push(`${where}: must be an object`);
            return;
        }
        requiredString(entry, 'pluginEntryId', where, problems);
        if (Array.isArray(options.inputIds) && options.inputIds[index] !== undefined && entry.pluginEntryId !== options.inputIds[index]) {
            problems.push(`${where}: pluginEntryId '${String(entry.pluginEntryId)}' is out of order (expected '${options.inputIds[index]}')`);
        }
        if (typeof entry.success !== 'boolean') {
            problems.push(`${where}: 'success' must be a boolean`);
            return;
        }
        if (entry.success) {
            onSuccess(entry, where, problems);
        } else {
            entryError(entry.error, where, problems);
        }
    });
    return problems;
}

/**
 * @param {unknown} status
 * @param {ValidateOptions} options
 * @param {string} where
 * @param {string[]} problems
 */
function pullToken(status, options, where, problems) {
    if (status === null || status === undefined) {
        return;
    }
    const pull = options.manifest && options.manifest.syncOptions && options.manifest.syncOptions.statusVocabulary
        ? options.manifest.syncOptions.statusVocabulary.pull
        : null;
    if (isRecord(pull) && !(String(status) in pull)) {
        problems.push(`${where}: status '${String(status)}' is not a key of syncOptions.statusVocabulary.pull`);
    }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isBytes(value) {
    return value instanceof Uint8Array;
}

/** @type {Record<string, (result: unknown, options: ValidateOptions) => string[]>} */
const VALIDATORS = {
    testCredentials(result) {
        return typeof result === 'boolean' ? [] : ['testCredentials: must resolve to a boolean'];
    },

    search(result) {
        if (!Array.isArray(result)) {
            return ['search: must return PluginMatchCandidate[]'];
        }
        /** @type {string[]} */
        const problems = [];
        result.forEach((c, index) => {
            const where = `search[${index}]`;
            if (!isRecord(c)) {
                problems.push(`${where}: must be an object`);
                return;
            }
            requiredString(c, 'pluginEntryId', where, problems);
            if (typeof c.title !== 'string') {
                problems.push(`${where}: 'title' must be a string`);
            }
            if (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1) {
                problems.push(`${where}: 'confidence' must be a number in 0–1`);
            }
            nullableField(c, 'canonicalUrl', 'string', where, problems);
            if (c.cached !== undefined && typeof c.cached !== 'boolean') {
                problems.push(`${where}: 'cached' must be a boolean when present`);
            }
            if (c.fetchedAt !== undefined && typeof c.fetchedAt !== 'string') {
                problems.push(`${where}: 'fetchedAt' must be an ISO string when present`);
            }
        });
        return problems;
    },

    lookup(result) {
        if (!isRecord(result)) {
            return ['lookup: must return a PluginEntryDetail object'];
        }
        /** @type {string[]} */
        const problems = [];
        requiredString(result, 'pluginEntryId', 'lookup', problems);
        nullableField(result, 'canonicalUrl', 'string', 'lookup', problems);
        return problems;
    },

    enrich(result, options) {
        return perEntryArray(result, 'enrich', options, (entry, where, problems) => {
            if (!isRecord(entry.contribution)) {
                problems.push(`${where}: a successful entry carries 'contribution'`);
            }
        });
    },

    searchCovers(result) {
        if (!Array.isArray(result)) {
            return ['searchCovers: must return PluginCoverResult[]'];
        }
        /** @type {string[]} */
        const problems = [];
        result.forEach((c, index) => {
            const where = `searchCovers[${index}]`;
            if (!isRecord(c)) {
                problems.push(`${where}: must be an object`);
                return;
            }
            requiredString(c, 'coverId', where, problems);
            requiredString(c, 'imageUrl', where, problems);
        });
        return problems;
    },

    downloadCover(result) {
        return isBytes(result) ? [] : ['downloadCover: must resolve to image bytes (Buffer)'];
    },

    pullProgress(result, options) {
        if (!isRecord(result)) {
            return ['pullProgress: must return a PluginPullResult object'];
        }
        /** @type {string[]} */
        const problems = [];
        requiredString(result, 'pluginEntryId', 'pullProgress', problems);
        nullableField(result, 'status', 'string', 'pullProgress', problems);
        nullableField(result, 'chapter', 'number', 'pullProgress', problems);
        nullableField(result, 'rating', 'number', 'pullProgress', problems);
        nullableField(result, 'lastUpdated', 'string', 'pullProgress', problems);
        pullToken(result.status, options, 'pullProgress', problems);
        return problems;
    },

    pushProgress(result, options) {
        return perEntryArray(result, 'pushProgress', options, (entry, where, problems) => {
            if (!('applied' in entry)) {
                problems.push(`${where}: 'applied' is missing (what the source now holds, or null)`);
            } else if (entry.applied !== null && !isRecord(entry.applied)) {
                problems.push(`${where}: 'applied' must be an object or null`);
            }
        });
    },

    getReadingList(result, options) {
        if (!Array.isArray(result)) {
            return ['getReadingList: must return PluginReadingListEntry[]'];
        }
        /** @type {string[]} */
        const problems = [];
        result.forEach((e, index) => {
            const where = `getReadingList[${index}]`;
            if (!isRecord(e)) {
                problems.push(`${where}: must be an object`);
                return;
            }
            requiredString(e, 'pluginEntryId', where, problems);
            for (const key of ['title', 'canonicalUrl', 'status', 'lastUpdated']) {
                nullableField(e, key, 'string', where, problems);
            }
            for (const key of ['chapter', 'rating', 'volume', 'listId', 'priority']) {
                nullableField(e, key, 'number', where, problems);
            }
            if ('comparison' in e) {
                problems.push(`${where}: 'comparison' left the contract (A13): the host compares`);
            }
            pullToken(e.status, options, where, problems);
        });
        return problems;
    },

    subscribe(result, options) {
        return perEntryArray(result, 'subscribe', options, (entry, where, problems) => {
            nullableField(entry, 'listId', 'number', where, problems);
            nullableField(entry, 'status', 'string', where, problems);
        });
    },

    unsubscribe(result, options) {
        return perEntryArray(result, 'unsubscribe', options, () => {});
    },

    queryLive(result) {
        if (!isRecord(result)) {
            return ['queryLive: must return a PluginLiveQueryResult object'];
        }
        /** @type {string[]} */
        const problems = [];
        const arms = ['ok', 'offline', 'not_found', 'error'];
        if (!arms.includes(/** @type {string} */ (result.status))) {
            return [`queryLive: status must be one of ${arms.join(', ')}`];
        }
        if (result.status === 'ok') {
            const data = result.data;
            if (!isRecord(data)) {
                return ['queryLive: the ok arm carries data'];
            }
            requiredString(data, 'pluginEntryId', 'queryLive.data', problems);
            requiredString(data, 'fetchedAt', 'queryLive.data', problems);
            if (!Array.isArray(data.sections)) {
                problems.push(`queryLive.data: 'sections' must be an array`);
            }
            if ('linkState' in data) {
                problems.push(`queryLive.data: 'linkState' left the contract (A4): the host derives link state`);
            }
        }
        if (result.status === 'error' && typeof result.retryable !== 'boolean') {
            problems.push(`queryLive: the error arm carries 'retryable'`);
        }
        return problems;
    },

    summarizeEntries(result, options) {
        return perEntryArray(result, 'summarizeEntries', options, (entry, where, problems) => {
            const summary = entry.summary;
            if (!isRecord(summary)) {
                problems.push(`${where}: a successful entry carries 'summary'`);
                return;
            }
            nullableField(summary, 'label', 'string', `${where}.summary`, problems);
            nullableField(summary, 'status', 'string', `${where}.summary`, problems);
            nullableField(summary, 'latestChapter', 'number', `${where}.summary`, problems);
            nullableField(summary, 'lastUpdated', 'string', `${where}.summary`, problems);
            if ('linkState' in summary) {
                problems.push(`${where}.summary: 'linkState' left the contract (A4): a plugin never reports link state`);
            }
        });
    },

    listChapters(result) {
        if (!isRecord(result)) {
            return ['listChapters: must return { chapters, availableLanguages }'];
        }
        /** @type {string[]} */
        const problems = [];
        if (!Array.isArray(result.availableLanguages) || result.availableLanguages.some((l) => typeof l !== 'string')) {
            problems.push(`listChapters: 'availableLanguages' must be string[] ([] for a source with no language concept)`);
        }
        if (!Array.isArray(result.chapters)) {
            problems.push(`listChapters: 'chapters' must be PluginChapterSummary[]`);
            return problems;
        }
        result.chapters.forEach((c, index) => {
            const where = `listChapters.chapters[${index}]`;
            if (!isRecord(c)) {
                problems.push(`${where}: must be an object`);
                return;
            }
            requiredString(c, 'id', where, problems);
            if (typeof c.label !== 'string') {
                problems.push(`${where}: 'label' must be a string`);
            }
            if (typeof c.ordering !== 'number') {
                problems.push(`${where}: 'ordering' must be a number`);
            }
            if (typeof c.language !== 'string') {
                problems.push(`${where}: 'language' must be a string ('' for no language concept)`);
            }
        });
        return problems;
    },

    listPages(result) {
        if (!Array.isArray(result)) {
            return ['listPages: must return PluginPageSummary[]'];
        }
        /** @type {string[]} */
        const problems = [];
        result.forEach((p, index) => {
            const where = `listPages[${index}]`;
            if (!isRecord(p)) {
                problems.push(`${where}: must be an object`);
                return;
            }
            requiredString(p, 'pageKey', where, problems);
            if (typeof p.pageNumber !== 'number') {
                problems.push(`${where}: 'pageNumber' must be a number`);
            }
            if (p.sizeHint !== undefined && typeof p.sizeHint !== 'number') {
                problems.push(`${where}: 'sizeHint' must be a number when present`);
            }
        });
        return problems;
    },

    downloadPage(result) {
        return isBytes(result) ? [] : ['downloadPage: must resolve to image bytes (Buffer)'];
    },

    queryFilter(result) {
        if (!isRecord(result)) {
            return ['queryFilter: must return a PluginFilterResult { applicable, pluginEntryIds } (A21)'];
        }
        /** @type {string[]} */
        const problems = [];
        if (typeof result.applicable !== 'boolean') {
            problems.push(`queryFilter: 'applicable' must be a boolean`);
        }
        if (!Array.isArray(result.pluginEntryIds) || result.pluginEntryIds.some((id) => typeof id !== 'string')) {
            problems.push(`queryFilter: 'pluginEntryIds' must be string[]`);
        } else if (result.applicable === false && result.pluginEntryIds.length) {
            problems.push(`queryFilter: a result that is not applicable carries no ids`);
        }
        return problems;
    },

    listEntries(result) {
        if (!isRecord(result)) {
            return ['listEntries: must return a PluginEntryPage { entries, totalCount, page, pageSize } (§5.4)'];
        }
        /** @type {string[]} */
        const problems = [];
        for (const key of ['totalCount', 'page', 'pageSize']) {
            if (typeof result[key] !== 'number') problems.push(`listEntries: '${key}' must be a number`);
        }
        if (!Array.isArray(result.entries)) {
            problems.push(`listEntries: 'entries' must be PluginWorkspaceEntry[]`);
            return problems;
        }
        result.entries.forEach((entry, index) => workspaceEntry(entry, `listEntries.entries[${index}]`, problems));
        return problems;
    },

    getEntry(result) {
        if (result === null) return [];
        /** @type {string[]} */
        const problems = [];
        workspaceEntry(result, 'getEntry', problems);
        return problems;
    },
};

/**
 * PluginWorkspaceEntry (§2.6, A22): only the fields the host reads are checked; the rest is the plugin's surface's.
 * @param {unknown} entry
 * @param {string} where
 * @param {string[]} problems
 */
function workspaceEntry(entry, where, problems) {
    if (!isRecord(entry)) {
        problems.push(`${where}: must be an object`);
        return;
    }
    requiredString(entry, 'pluginEntryId', where, problems);
    if (typeof entry.title !== 'string') {
        problems.push(`${where}: 'title' must be a string`);
    }
    if (entry.altTitles !== undefined && (!Array.isArray(entry.altTitles) || entry.altTitles.some((t) => typeof t !== 'string'))) {
        problems.push(`${where}: 'altTitles' must be string[] when present`);
    }
}

/**
 * @param {string} method - a §2 method name
 * @param {unknown} result
 * @param {ValidateOptions} [options]
 * @returns {string[]} problems; empty when the result is the contract's
 */
function validateResult(method, result, options = {}) {
    const validator = VALIDATORS[method];
    if (!validator) {
        return [`${method}: no contract result shape is defined for this method`];
    }
    return validator(result, options || {});
}

module.exports = {
    validateResult,
    VALIDATED_METHODS: Object.freeze(Object.keys(VALIDATORS)),
};
