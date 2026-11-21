'use strict';

/**
 * DTO validators for every §2 result shape (contract §2.6 and the typedefs it names). One function,
 * `validateResult(method, result, options)`, returns the list of problems — empty when the result is the
 * contract's. The host's Dispatching delegate runs the same validators on what a plugin returns
 * (`contract_violation`), and the conformance runner runs them on every bound method.
 */

const { PLUGIN_ERROR_CODES } = require('./errors.cjs');
const { ALT_TITLES_CONTRACT_VERSION, SERIES_STATUSES, CONTENT_RATINGS, DISPLAY_TITLE_KINDS } = require('./contract.cjs');

/** @typedef {{ manifest?: { syncOptions?: any, pluginContractVersion?: string } | null, inputIds?: string[] | null }} ValidateOptions */

/**
 * Whether the manifest's contract version requires `altTitles` on a list entry (A30). With no manifest, the
 * current contract's rule.
 * @param {ValidateOptions} options
 * @returns {boolean}
 */
function altTitlesRequired(options) {
    const version = options && options.manifest ? options.manifest.pluginContractVersion : undefined;
    if (typeof version !== 'string' || !version) return true;
    const a = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
    const b = ALT_TITLES_CONTRACT_VERSION.split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return true;
}

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

// ---------------------------------------------------------------------------
// The record and its display part (§2.4.1, §2.6; 4.4.0, A32–A34, A38)
// ---------------------------------------------------------------------------

/** A32: the candidate holds the record's identity; `detail` never repeats it, and a search invents no sync time. */
const RECORD_IDENTITY_KEYS = Object.freeze(['pluginEntryId', 'canonicalUrl', 'syncedAt', 'syncIntervalHint', 'cached', 'fetchedAt']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isStringArray(value) {
    return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * A32: a field the source does not hold is absent — never `null`, an empty string or an empty list.
 * @param {Record<string, unknown>} obj
 * @param {string} where
 * @param {string[]} problems
 * @returns {string[]} the keys holding a value, to be checked further
 */
function heldKeys(obj, where, problems) {
    /** @type {string[]} */
    const keys = [];
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;
        if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
            problems.push(`${where}.${key}: a field the source does not hold is absent, never null, '' or [] (A32)`);
            continue;
        }
        keys.push(key);
    }
    return keys;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {string[]} problems
 */
function contributors(value, where, problems) {
    if (!Array.isArray(value) || value.some((c) => !(typeof c === 'string' || (isRecord(c) && typeof c.name === 'string' && (c.type === undefined || typeof c.type === 'string'))))) {
        problems.push(`${where}: must be PluginContributor[] (a name, or { name, type? })`);
    }
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {string[]} problems
 */
function seriesStatus(value, where, problems) {
    if (value !== undefined && !SERIES_STATUSES.includes(/** @type {string} */ (value))) {
        problems.push(`${where}: '${String(value)}' is not one of ${SERIES_STATUSES.join(', ')}`);
    }
}

/**
 * An array of objects, each checked by `each`.
 * @param {unknown} value
 * @param {string} where
 * @param {string[]} problems
 * @param {(item: Record<string, unknown>, itemWhere: string) => void} each
 */
function objectList(value, where, problems, each) {
    if (!Array.isArray(value)) {
        problems.push(`${where}: must be an array`);
        return;
    }
    value.forEach((item, index) => {
        const itemWhere = `${where}[${index}]`;
        if (!isRecord(item)) problems.push(`${itemWhere}: must be an object`);
        else each(item, itemWhere);
    });
}

/**
 * Each named field of `obj`, where present, has the given type.
 * @param {Record<string, unknown>} obj
 * @param {Record<string, 'string' | 'number' | 'boolean'>} types
 * @param {string} where
 * @param {string[]} problems
 */
function typedFields(obj, types, where, problems) {
    for (const [key, type] of Object.entries(types)) {
        if (obj[key] !== undefined && typeof obj[key] !== type) problems.push(`${where}.${key}: must be a ${type}`);
    }
}

/**
 * An object whose named fields, where present, have the given types (and nothing is null or empty).
 * @param {unknown} value
 * @param {Record<string, 'string' | 'number' | 'boolean'>} types
 * @param {string} where
 * @param {string[]} problems
 * @returns {Record<string, unknown> | null}
 */
function typedObject(value, types, where, problems) {
    if (!isRecord(value)) {
        problems.push(`${where}: must be an object`);
        return null;
    }
    heldKeys(value, where, problems);
    typedFields(value, types, where, problems);
    return value;
}

/**
 * `PluginEntryDisplay` (A33): every field optional, each its §2.6 type.
 * @param {unknown} display
 * @param {string} where
 * @param {string[]} problems
 */
function entryDisplay(display, where, problems) {
    if (!isRecord(display)) {
        problems.push(`${where}: must be a PluginEntryDisplay object`);
        return;
    }
    for (const key of heldKeys(display, where, problems)) {
        const value = display[key];
        const at = `${where}.${key}`;
        switch (key) {
            case 'titles':
                objectList(value, at, problems, (t, w) => {
                    if (typeof t.title !== 'string' || !t.title) problems.push(`${w}.title: must be a non-empty string`);
                    if (!DISPLAY_TITLE_KINDS.includes(/** @type {string} */ (t.kind))) problems.push(`${w}.kind: must be one of ${DISPLAY_TITLE_KINDS.join(', ')}`);
                    typedFields(t, { language: 'string' }, w, problems);
                });
                break;
            case 'descriptions':
                objectList(value, at, problems, (d, w) => {
                    if (typeof d.text !== 'string' || !d.text) problems.push(`${w}.text: must be a non-empty string`);
                    typedFields(d, { language: 'string' }, w, problems);
                });
                break;
            case 'cover': {
                const cover = typedObject(value, {}, at, problems);
                if (!cover) break;
                objectList(cover.sizes, `${at}.sizes`, problems, (s, w) => {
                    if (typeof s.url !== 'string' || !s.url) problems.push(`${w}.url: must be a non-empty string`);
                    typedFields(s, { width: 'number' }, w, problems);
                });
                if (cover.placeholder !== undefined && !(isRecord(cover.placeholder) && typeof cover.placeholder.blurhash === 'string' && cover.placeholder.blurhash)) {
                    problems.push(`${at}.placeholder: must be { blurhash: string }`);
                }
                break;
            }
            case 'originalLanguage':
            case 'demographic':
            case 'statusText':
            case 'magazine':
                if (typeof value !== 'string') problems.push(`${at}: must be a string`);
                break;
            case 'contentRating':
                if (!CONTENT_RATINGS.includes(/** @type {string} */ (value))) problems.push(`${at}: '${String(value)}' is not one of ${CONTENT_RATINGS.join(', ')}`);
                break;
            case 'dates':
                typedObject(value, { started: 'string', ended: 'string', updated: 'string' }, at, problems);
                break;
            case 'volumes':
            case 'chapters':
                typedObject(value, { final: 'number', latest: 'number', total: 'number' }, at, problems);
                break;
            case 'tags':
                objectList(value, at, problems, (t, w) => {
                    if (typeof t.name !== 'string' || !t.name) problems.push(`${w}.name: must be a non-empty string`);
                    typedFields(t, { group: 'string', path: 'string', spoiler: 'boolean', votes: 'number' }, w, problems);
                });
                break;
            case 'ratings':
                objectList(value, at, problems, (r, w) => {
                    if (typeof r.source !== 'string' || !r.source) problems.push(`${w}.source: must be a non-empty string`);
                    if (typeof r.scale !== 'number' || !(r.scale > 0)) problems.push(`${w}.scale: must be a number above 0`);
                    if (typeof r.value !== 'number' || r.value < 0 || (typeof r.scale === 'number' && r.value > r.scale)) {
                        problems.push(`${w}.value: must be a number within 0–scale (its percentage is value / scale)`);
                    }
                    typedFields(r, { votes: 'number' }, w, problems);
                });
                break;
            case 'popularity':
                typedObject(value, { rank: 'number', follows: 'number', lists: 'number' }, at, problems);
                break;
            case 'licensing':
                typedObject(value, { licensed: 'boolean', anime: 'boolean' }, at, problems);
                break;
            case 'relations':
                objectList(value, at, problems, (r, w) => {
                    if (typeof r.relation !== 'string' || !r.relation) problems.push(`${w}.relation: must be a non-empty string`);
                    typedFields(r, { title: 'string', pluginEntryId: 'string', url: 'string' }, w, problems);
                });
                break;
            case 'recommendations':
                objectList(value, at, problems, (r, w) => {
                    if (typeof r.title !== 'string' || !r.title) problems.push(`${w}.title: must be a non-empty string`);
                    typedFields(r, { pluginEntryId: 'string', url: 'string' }, w, problems);
                });
                break;
            case 'links':
                objectList(value, at, problems, (l, w) => {
                    if (typeof l.label !== 'string' || !l.label) problems.push(`${w}.label: must be a non-empty string`);
                    if (typeof l.url !== 'string' || !l.url) problems.push(`${w}.url: must be a non-empty string`);
                    typedFields(l, { type: 'string', language: 'string' }, w, problems);
                });
                break;
            case 'translations':
                objectList(value, at, problems, (t, w) => {
                    if (typeof t.language !== 'string' || !t.language) problems.push(`${w}.language: must be a non-empty string`);
                });
                break;
            case 'site': {
                const site = typedObject(value, { id: 'string', label: 'string', address: 'string', path: 'string' }, at, problems);
                if (site && (typeof site.id !== 'string' || typeof site.label !== 'string')) problems.push(`${at}: carries 'id' and 'label'`);
                break;
            }
            case 'progress':
                typedObject(value, { chapter: 'number', downloaded: 'number', checking: 'boolean' }, at, problems);
                break;
            case 'folder': {
                const folder = typedObject(value, { path: 'string', exists: 'boolean' }, at, problems);
                if (folder && (typeof folder.path !== 'string' || typeof folder.exists !== 'boolean')) problems.push(`${at}: carries 'path' and 'exists'`);
                break;
            }
            default:
                problems.push(`${at}: not a PluginEntryDisplay field (§2.6); a kind of information no field holds waits for the contract's vocabulary to grow`);
        }
    }
}

/**
 * The contribution's descriptive fields, where present, each its §2.6 type.
 * @param {Record<string, unknown>} rec
 * @param {string} where
 * @param {string[]} problems
 */
function descriptiveFields(rec, where, problems) {
    typedFields(rec, { displayTitle: 'string', description: 'string', coverUrl: 'string', year: 'number', seriesType: 'string' }, where, problems);
    for (const key of ['altTitles', 'genres', 'tags']) {
        if (rec[key] !== undefined && !isStringArray(rec[key])) problems.push(`${where}.${key}: must be string[]`);
    }
    for (const key of ['authors', 'artists', 'publishers']) {
        if (rec[key] !== undefined) contributors(rec[key], `${where}.${key}`, problems);
    }
    if (rec.sourceLinks !== undefined && !Array.isArray(rec.sourceLinks)) problems.push(`${where}.sourceLinks: must be PluginSourceLink[]`);
    seriesStatus(rec.seriesStatus, `${where}.seriesStatus`, problems);
}

/**
 * A32: `PluginEntryRecord`, a candidate's `detail`.
 * @param {unknown} detail
 * @param {string} where
 * @param {string[]} problems
 */
function entryRecord(detail, where, problems) {
    if (!isRecord(detail)) {
        problems.push(`${where}: must be a PluginEntryRecord object`);
        return;
    }
    for (const key of RECORD_IDENTITY_KEYS) {
        if (detail[key] !== undefined) problems.push(`${where}.${key}: the candidate holds the record's identity; detail never repeats it (A32)`);
    }
    heldKeys(detail, where, problems);
    descriptiveFields(detail, where, problems);
    if (detail.display !== undefined && detail.display !== null) entryDisplay(detail.display, `${where}.display`, problems);
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
            if (c.altTitles !== undefined && !isStringArray(c.altTitles)) {
                problems.push(`${where}: 'altTitles' must be string[] when present`);
            }
            // A32 (4.4.0): the record as far as the search response holds it.
            if (c.detail !== undefined) entryRecord(c.detail, `${where}.detail`, problems);
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
        seriesStatus(result.seriesStatus, 'lookup.seriesStatus', problems);
        // A33 (4.4.0): everything the source holds for the entry.
        if (result.display !== undefined) entryDisplay(result.display, 'lookup.display', problems);
        return problems;
    },

    enrich(result, options) {
        return perEntryArray(result, 'enrich', options, (entry, where, problems) => {
            if (!isRecord(entry.contribution)) {
                problems.push(`${where}: a successful entry carries 'contribution'`);
                return;
            }
            // A31 (4.3.0): a contribution answered from the plugin's cache says so, as a search candidate does (§2.4).
            const c = /** @type {Record<string, unknown>} */ (entry.contribution);
            if (c.cached !== undefined && typeof c.cached !== 'boolean') {
                problems.push(`${where}.contribution: 'cached' must be a boolean when present`);
            }
            if (c.fetchedAt !== undefined && typeof c.fetchedAt !== 'string') {
                problems.push(`${where}.contribution: 'fetchedAt' must be an ISO string when present`);
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
            // A30: a package built at 4.2.0 or later carries altTitles (string[], or null where the source has none).
            if (altTitlesRequired(options)) {
                if (!('altTitles' in e)) {
                    problems.push(`${where}: 'altTitles' is missing (A30: string[], or null where the source's list carries none)`);
                } else if (e.altTitles !== null && (!Array.isArray(e.altTitles) || e.altTitles.some((t) => typeof t !== 'string'))) {
                    problems.push(`${where}: 'altTitles' must be string[] or null (A30)`);
                }
            } else if (e.altTitles !== undefined && e.altTitles !== null && (!Array.isArray(e.altTitles) || e.altTitles.some((t) => typeof t !== 'string'))) {
                problems.push(`${where}: 'altTitles' must be string[] or null when present`);
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
