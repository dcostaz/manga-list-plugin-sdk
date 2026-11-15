'use strict';

// Typecheck-only: testing/index.d.ts declares what testing/index.cjs exports. `npm run typecheck` fails when
// the two drift apart. Not a node:test file; nothing runs it.

/** @type {typeof import('../testing/index')} */
const declared = require('../testing/index.cjs');

module.exports = declared;
