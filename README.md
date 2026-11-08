# @manga-list/plugin-sdk

The plugin side of the manga-list host capability contract (`docs/plugins/host-capability-contract.md` in the
host repo). A plugin ships a **definition**; the SDK builds the descriptor the host's loader expects, so a plugin
cannot expose a method the contract does not name. Host-owned; built by
`docs/plans/Plan-2026Q4-tracker-plugin-standardization.md` (Phase 1).

**The SDK's version is the contract version.** A manifest's `pluginContractVersion` names the SDK version the
plugin was built against; the host compares majors and refuses a newer minor than its own.

## Install

A plugin repo takes it as a devDependency pinned to the contract's tag; the host as a dependency, the same way:

```json
"@manga-list/plugin-sdk": "github:dcostaz/manga-list-plugin-sdk#v4.0.0"
```

A plugin's zip never bundles it: the host places its own installed copy beside the plugin runtime root, where a
plugin's `require('@manga-list/plugin-sdk')` finds it.

## What a tracker writes

```
client-<id>.cjs   L4  reach and exchange: endpoints, the auth strategy, throttle names, pagination
mapping-<id>.cjs  L3b map: pure functions, source shape ↔ contract DTO
plugin-<id>.cjs   L3a declare and bind: defineTrackerPlugin({ manifest, settings, auth, createClient, methods })
```

```js
const { defineTrackerPlugin, perEntry } = require('@manga-list/plugin-sdk');

module.exports = defineTrackerPlugin({
  manifest: require('./plugin-package.json'),
  settings: require('./<id>-api-settings.json'),   // { metadata, schema, settings }
  auth,                                             // { exchange, apply, isAuthFailure? }, or null
  createClient,                                     // ({ settings, utils, addNormalizer }) => (view) => client
  methods: {                                        // keyed by contract METHOD name
    search:         async (view, query, options) => map.candidates(await view.client.search(query, options)),
    getReadingList: async (view) => map.readingList(await view.client.library()),   // sync.list + watch.list
    subscribe:      async (view, entries) => perEntry(entries, (e) => view.client.addToList(e)),
  },
});
// → { pluginName, displayName, WrapperClass, SettingsClass }
```

- **Bindings are keyed by method.** The SDK holds the contract's offer → method table and fails at `require`
  time, by name, for a declared offer whose method has no binding and for a binding no declared offer needs.
  `sync.list` and `watch.list` share `getReadingList`: bind it once; the plugin never knows which offer called.
- **Bindings by convention.** Give `mapping` instead of (or beside) `methods`, and every method without an explicit
  binding is bound as `mapping[method](await view.client[method](...args), ...args)`; an array method calls the
  client once per entry through `perEntry`. The client then exposes one source call per contract method, named
  after it, and the mapping one function per method whose answer needs translating. An explicit binding always
  wins. The template uses the convention, so a new tracker edits only its client, mapping, manifest and settings.
- **The per-call view.** Every method's last argument from the host is `callContext { credential, identity,
  scope, signal }`; the facade pops it and hands the binding `view = { client, http, cache, credential,
  identity, scope, signal, settings, utils }`. `view.http` is the instance's HTTP bound to this call;
  `view.client` is your client built over that view. Nothing is retained after the call.
- **`http`** wraps the host's injected HTTP client with the plugin's settings: timeouts
  (`connection.timeout.*`), keep-alive pool, retry with backoff, `429` + `Retry-After`, the global limiter,
  per-endpoint throttle (`api.endpoints.<name>.throttle`, pass `endpoint: '<name>'`), circuit breaker, and the
  call's abort signal. Failures are `PluginError`s with the contract's codes.
- **`http.authed(fn)` / `http.authedRequest(config)`** — the one 401 shape: token set from the in-memory token
  cache (keyed by `identity`), else `auth.exchange(credential, { http, settings, previous, reason })`; `auth.apply(tokens,
  config)` per request; on an auth failure, re-exchange once under the same credential and replay once.
  `previous` carries the old set, so a refresh token survives an expired access token. A client may register
  response normalizers (`addNormalizer`), never a replay.
- **`view.cache`** — the host cache keyed by the call's `scope` (the acting user, or `system`). Never a token.
- **Results** — `perEntry()` for array offers (one result per entry, in order; a failure stays with its
  entry), `PluginError` (closed codes: `not_found`, `credential_rejected`, `rate_limited`, `offline`,
  `source_error`), `markCached()` for §2.4, `notFoundEntry()`. Never classify a `PluginError` with
  `instanceof`: use `isPluginError()` (two SDK copies exist at runtime).
- **The settings class** is generic: no plugin writes one.

## Testing

```js
const { runConformance, createStubAxios, createStubContext, callContext } = require('@manga-list/plugin-sdk/testing');
```

`runConformance({ WrapperClass, manifest, descriptor, initOptions, axios, context })` runs the contract cases
against a loaded `WrapperClass` — built by the SDK or by hand — and returns `{ passed, failed }`.

```
npm test          # node --test
npm run typecheck # tsc --noEmit, strict, checkJs
```

## Delivery

No runtime dependencies: `http` wraps the host's injected client, the cache wraps the host's adapter. The host
depends on this package and, at start, install and reload, copies its installed copy to
`<appData>/plugins/node_modules/@manga-list/plugin-sdk`, where a plugin's plain
`require('@manga-list/plugin-sdk')` resolves by Node's walk-up from `<appData>/plugins/runtime/<package>/`.
