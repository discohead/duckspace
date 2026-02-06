# Research: Electron Foundation (Phase 1)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)
**Date**: 2026-02-05

---

## Research Questions

### RQ-1: DuckDB Native Addon for Electron Worker Threads

**Question**: Which DuckDB Node.js client works in Electron Worker Threads with N-API prebuilt binaries (no electron-rebuild)?

**Finding**: Use `@duckdb/node-api` (the "Neo" client) ^1.4.4.

- **N-API based**: Uses Node-API (ABI-stable), so prebuilt binaries work across Node.js versions without recompilation. `electron-rebuild` is NOT required.
- **Worker Thread compatible**: Designed for Node.js `worker_threads`. The native addon loads cleanly in V8 isolates.
- **Prebuilt binaries**: Published for macOS arm64 and x64 via npm. Automatically selected at install time.
- **API surface**: `DuckDBInstance.create()` → `instance.connect()` → `connection.run()` / `connection.stream()`. Async/await based.
- **Arrow IPC output**: The Neo client does NOT yet expose a native `arrowIPCAll()` JS method. Workaround: use DuckDB's built-in SQL function `to_arrow_ipc()`:
  ```sql
  SELECT * FROM to_arrow_ipc((SELECT col1, col2 FROM my_table WHERE condition));
  ```
  This returns a `Uint8Array` containing Arrow IPC Stream format directly from the SQL engine. Transfer via `MessagePort` with `ArrayBuffer` in the transferable list for zero-copy.
- **Version note**: ^1.4.4 aligns with DuckDB core 1.4.x. The package is published as `@duckdb/node-api` on npm.

**Alternatives considered**:
- `duckdb` (legacy client): Uses older N-API patterns, callback-based API, less Worker Thread friendly.
- `duckdb-async`: Wrapper around legacy client — same underlying limitations.

**Sources**: npm registry, DuckDB GitHub (duckdb/duckdb-node-neo), DuckDB documentation.

---

### RQ-2: Arrow JS Library for Renderer-Side Decode

**Question**: What is the best Arrow IPC decoder for the Renderer process — `apache-arrow` or an alternative?

**Finding**: Use `@uwdata/flechette` ^2.3.0.

- **Size**: ~38KB min+gz (vs ~150KB for apache-arrow). 4x smaller bundle footprint.
- **Performance**: 1.3-5.4x faster IPC decoding than apache-arrow in benchmarks.
- **DuckDB type coverage**: Supports LIST, MAP, UNION, and other complex types that DuckDB produces. apache-arrow has gaps in these areas.
- **API**: `tableFromIPC(buffer)` → Table with columnar arrays. Zero-copy when possible (reuses the underlying ArrayBuffer).
- **Recommendation source**: DuckDB team explicitly recommends Flechette for DuckDB Arrow IPC consumers.
- **Compatibility**: Works in any modern browser/Chromium environment. ESM native.
- **Maintained by**: UW Interactive Data Lab (same group as Vega/Vega-Lite/Arquero).

**Alternatives considered**:
- `apache-arrow` JS: Larger, slower, incomplete DuckDB type support. Still acceptable but Flechette is strictly better for this use case.

**Sources**: npm registry, Flechette GitHub (uwdata/flechette), DuckDB blog posts, Observable/UW benchmarks.

---

### RQ-3: Electron Build Toolchain

**Question**: What is the recommended build pipeline for an Electron + React + TypeScript + Vite application?

**Finding**: Electron Forge v7.x with `@electron-forge/plugin-vite`.

- **Electron Forge**: Official Electron build tool. Handles packaging (`forge package`), making distributables (`forge make` → DMG, ZIP), code signing, auto-update.
- **Vite plugin**: `@electron-forge/plugin-vite` integrates Vite as the bundler for both main and renderer processes. Provides HMR for the renderer during development.
- **Configuration**: `forge.config.ts` defines main/preload entry points (built by Vite in "main" mode) and renderer entry points (built by Vite in "renderer" mode with React plugin).
- **TypeScript**: Vite handles TypeScript compilation natively. Add `@vitejs/plugin-react` for JSX transform.
- **Native addons**: Forge's Vite plugin has `external` configuration to exclude native N-API addons from bundling (DuckDB binary must be loaded from node_modules at runtime, not bundled).
- **macOS packaging**: `@electron-forge/maker-dmg` for DMG creation. `@electron-forge/maker-zip` for ZIP. Code signing via `osx-sign` configuration in forge config.

**Electron version**: v33+ (not v28).
- Electron v28 reached end-of-life. No security patches.
- v33+ provides Node-API v9, matching `@duckdb/node-api` prebuilt binary requirements.
- v33+ includes latest Chromium (for IndexedDB improvements, CSS features, WebGL2 stability).

**Alternatives considered**:
- electron-builder: Also viable but Forge is the officially maintained tool with better Vite integration.
- electron-vite: Third-party, less mature, duplicates what Forge+Vite plugin provides.

**Sources**: Electron Forge documentation, npm registry, Electron release notes.

---

### RQ-4: Testing Stack for Electron Applications

**Question**: What testing framework supports unit tests (fast, TypeScript) and E2E tests (launch real Electron app)?

**Finding**: Vitest ^3.x (unit/integration) + Playwright ^1.52+ (E2E).

**Vitest**:
- Fast test runner, native ESM support, first-class TypeScript.
- Compatible with Vite configuration (shares `vite.config.ts` resolution).
- Supports `vi.mock()` for mocking Worker Threads, IPC, and native addons.
- Run via `vitest run` (CI) or `vitest` (watch mode).

**Playwright for Electron**:
- Playwright ^1.52+ supports launching Electron apps via CDP.
- `electron = await _electron.launch({ args: ['path/to/main.js'] })` — launches the real app.
- `window = await electron.firstWindow()` — gets a Page object for the renderer.
- Can inspect Main Process via `electron.evaluate()`.
- Can test MessagePort communication, Arrow IPC round-trips, and real DuckDB queries in E2E.
- Supports screenshot comparison for visual regression.

**Test tiers**:
| Tier | Framework | Scope | Speed |
|------|-----------|-------|-------|
| Unit | Vitest | Individual functions, pure logic, type validators | <5s total |
| Integration | Vitest | DuckDB Worker in isolation, Arrow encode/decode, Dexie.js stores | <30s total |
| E2E | Playwright | Full app launch, query execution, tab persistence, crash recovery | <2min total |

**Alternatives considered**:
- Spectron: Deprecated, no longer maintained.
- Jest: Slower than Vitest, worse ESM support, heavier configuration.
- WebDriverIO: Viable for E2E but Playwright has better Electron integration.

**Sources**: Vitest documentation, Playwright Electron guide, npm registry.

---

### RQ-5: Dexie.js for Reactive UI State in Electron

**Question**: Does Dexie.js work reliably in Electron's Renderer with `liveQuery()` for reactive state?

**Finding**: Yes. Dexie.js ^4.3.0 with `dexie-react-hooks` for `useLiveQuery()`.

- **Electron compatibility**: Dexie.js uses IndexedDB, which is provided by Chromium in Electron's Renderer. First-class support — no polyfills needed.
- **Reactive queries**: `useLiveQuery(() => db.tabs.orderBy('position').toArray())` returns a live-updating React state that re-renders when IndexedDB data changes.
- **Collections** (from data model spec): tabs, queries, catalog_entries, column_schemas, query_history, preferences, worker_health, recovery_log, app_state.
- **Performance**: IndexedDB operations are async but fast for the metadata-scale data Dexie manages (hundreds to low thousands of records). Not used for analytical data.
- **Schema versioning**: Dexie supports schema migrations via `db.version(n).stores({...})`. Important for future phases that add collections.
- **Bundle size**: ~83KB (Dexie + React hooks). Negligible relative to Electron baseline.

**Notes**:
- Dexie runs in the Renderer (not a Worker) per Constitution Principle IV documented deviation. `liveQuery()` provides zero-IPC reactive queries — data doesn't cross process boundaries.
- For crash recovery: Dexie data persists in IndexedDB across crashes. On abnormal shutdown detection, the app reads `recovery_log` and `app_state` collections to restore previous session.

**Sources**: Dexie.js documentation, dexie-react-hooks npm, Electron IndexedDB compatibility notes.

---

## Open Questions (Resolved)

All research questions have been resolved. No open unknowns remain for Phase 1.

## Impact on Plan

The research findings are incorporated into [plan.md](plan.md) Technical Context section. Key decisions:

1. **DuckDB client**: `@duckdb/node-api` with `to_arrow_ipc()` SQL workaround (not native JS Arrow method).
2. **Arrow decoder**: `@uwdata/flechette` replaces `apache-arrow` in the bundle budget.
3. **Electron version**: Upgraded from v28 (spec) to v33+ (research recommendation).
4. **Build tool**: Electron Forge + Vite (not electron-builder).
5. **Test stack**: Vitest + Playwright (not Jest + Spectron).
