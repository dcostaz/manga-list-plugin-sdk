'use strict';

/**
 * The generic SettingsClass (standardization plan Phase 1.1; contract §1.4): no plugin writes a settings
 * class again. It serves the plugin's settings document `{ metadata, schema, settings }` to the host:
 * `getAll()` (the resolved values the host path-expands into `serviceSettings`), `getMetadata()`,
 * `getSchema()` and `componentName` (what the Settings UI reads).
 *
 * Tiers (contract §3): the document's defaults, then the active user's saved overrides for this component
 * when the host passes `userSettingsService` and `userId`; the host applies path-token expansion after.
 */

const fs = require('fs').promises;
const { PLUGIN_SETTINGS_CONTRACT_VERSION } = require('./contract.cjs');

/**
 * @typedef {{ metadata: Record<string, any>, schema: Record<string, any>, settings: Record<string, unknown> }} SettingsDocument
 */

/**
 * @param {unknown} doc
 * @param {string} where
 * @returns {SettingsDocument}
 */
function assertSettingsDocument(doc, where) {
    /** @param {unknown} v */
    const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isRecord(doc)) {
        throw new Error(`settings document at ${where} must be an object`);
    }
    const d = /** @type {Record<string, unknown>} */ (doc);
    if (!isRecord(d.metadata) || !isRecord(d.schema) || !isRecord(d.settings)) {
        throw new Error(`settings document at ${where} must have metadata, schema and settings sections`);
    }
    const metadata = /** @type {Record<string, any>} */ (d.metadata);
    if (typeof metadata.componentName !== 'string' || !metadata.componentName) {
        throw new Error(`settings document at ${where} has no metadata.componentName`);
    }
    const declared = metadata.settingsContractVersion;
    if (declared !== undefined && String(declared).split('.')[0] !== PLUGIN_SETTINGS_CONTRACT_VERSION.split('.')[0]) {
        throw new Error(`settings document at ${where} declares settingsContractVersion '${declared}' (SDK=${PLUGIN_SETTINGS_CONTRACT_VERSION})`);
    }
    return /** @type {SettingsDocument} */ (d);
}

/**
 * @param {SettingsDocument | null} embedded - the definition's own document, used when the host passes no path
 */
function createSettingsClass(embedded) {
    const embeddedDoc = embedded ? assertSettingsDocument(embedded, 'the plugin definition') : null;

    class PluginSettings {
        /**
         * @param {{ document: SettingsDocument, settingsPath?: string, values: Record<string, unknown> }} params
         */
        constructor(params) {
            this._document = params.document;
            this._settingsPath = params.settingsPath || '';
            /** @type {Record<string, unknown>} */
            this._values = params.values;
            /** @type {string} */
            this.componentName = params.document.metadata.componentName;
        }

        /**
         * @param {{ settingsPath?: string, userSettingsService?: any, userId?: number | null }} [options]
         * @returns {Promise<PluginSettings>}
         */
        static async init(options = {}) {
            const settingsPath = typeof options.settingsPath === 'string' ? options.settingsPath : '';
            let document = embeddedDoc;
            if (settingsPath) {
                const raw = await fs.readFile(settingsPath, 'utf8');
                document = assertSettingsDocument(JSON.parse(raw), settingsPath);
            }
            if (!document) {
                throw new Error('settings: neither a settingsPath nor an embedded settings document was given');
            }
            const values = { ...document.settings };
            const service = options.userSettingsService;
            const userId = options.userId;
            if (service && typeof service.getUserSetting === 'function' && userId !== null && userId !== undefined) {
                for (const key of Object.keys(values)) {
                    const record = await service.getUserSetting(userId, document.metadata.componentName, key);
                    if (record && typeof record === 'object' && 'value' in record) {
                        values[key] = record.value;
                    }
                }
            }
            return new PluginSettings({ document, settingsPath, values });
        }

        /** @returns {Record<string, unknown>} a copy of the resolved flat values */
        getAll() {
            return { ...this._values };
        }

        /** The name the host reads first; the same values as getAll(). */
        toLegacyFormat() {
            return this.getAll();
        }

        /** @param {string} key */
        getSetting(key) {
            return this._values[key];
        }

        /** @param {string} key */
        get(key) {
            return this._values[key];
        }

        getMetadata() {
            return this._document.metadata;
        }

        getSchema() {
            return this._document.schema;
        }
    }

    return PluginSettings;
}

module.exports = { createSettingsClass, assertSettingsDocument };
