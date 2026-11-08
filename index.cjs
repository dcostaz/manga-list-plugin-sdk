'use strict';

/**
 * @manga-list/plugin-sdk — the plugin side of the host capability contract
 * (docs/plugins/host-capability-contract.md in the host repo). The SDK's version is the contract version.
 */

const contract = require('./src/contract.cjs');
const { defineTrackerPlugin } = require('./src/define.cjs');
const { PluginError, isPluginError, toPluginError, PLUGIN_ERROR_CODES, HOST_CONTRACT_VIOLATION, PLUGIN_ERROR_BRAND } = require('./src/errors.cjs');
const { perEntry, notFoundEntry, markCached } = require('./src/results.cjs');
const { validateResult, VALIDATED_METHODS } = require('./src/validators.cjs');
const { createSettingsClass, assertSettingsDocument } = require('./src/settings.cjs');

module.exports = {
    ...contract,
    defineTrackerPlugin,
    PluginError,
    isPluginError,
    toPluginError,
    PLUGIN_ERROR_CODES,
    PLUGIN_ERROR_BRAND,
    HOST_CONTRACT_VIOLATION,
    perEntry,
    notFoundEntry,
    markCached,
    validateResult,
    VALIDATED_METHODS,
    createSettingsClass,
    assertSettingsDocument,
};
