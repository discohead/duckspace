# QA Report: US4 (Watch Directories) & US5 (Manage Data Sources)

**Date:** 2026-02-08
**Branch:** `002-local-data-ingestion`
**Features:** Phase 6 (US4: Watch a folder) + Phase 7 (US5: Manage data sources)
**Tested via:** Playwright MCP (Electron)
**Unit tests:** 698/698 PASS (39 test files)

---

## Executive Summary

US4 WatchDirConfig UI is **functionally solid** for all CRUD operations and validation. A **P1 blocker** was found: chokidar file-watcher events do not propagate to the renderer after adding a watch directory, leaving source counts at 0 and preventing automatic file ingestion. US5 context menu and data source management could not be live-tested due to Playwright's inability to interact with Electron's native file dialog, but code review identified several P2 issues.

**Previous session also found and fixed:**
- P0: App crash on startup from missing Dexie `createdAt` index (fixed: v3 schema)
- P0: `db.watch_directories.put()` DataError from stale `.vite/build/main-entry.js` with stub IPC handlers (fixed: manual rebuild)

---

## Issues Found

### P0 (Fixed During QA)

| # | Issue | Root Cause | Fix Applied |
|---|-------|-----------|-------------|
| 1 | App crash on startup: "KeyPath createdAt not indexed" | Dexie v2 schema lacked `watch_directories` table | Added v3 schema with `createdAt` index, `DEXIE_SCHEMA_VERSION = 3` |
| 2 | All addDirectory operations fail with DataError | `.vite/build/main-entry.js` was stale (built Feb 8 00:33) with STUB handlers returning `{ success: false }` instead of `{ watchDirectory: watchDir }`. Preload's `.then(r => r.watchDirectory)` returned `undefined`; `{...undefined}` spread to `{}` missing `id` field | Manually rebuilt main-entry.js with Vite build API + Forge globals |

### P1 (Blocking)

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| 3 | File watcher events not propagating to renderer | `file-watcher.ts` -> `App.tsx` | After adding `/tmp/duckspace-qa/test-data` as a watch directory, `sourceCount` remains at 0. No data sources appear in the sidebar. Creating new files in the directory doesn't trigger events. Standalone chokidar test works correctly. Built main-entry.js has correct code (chokidar.watch, watcher.on, emitWatchFileEvent, importFiles). Cannot debug further via MCP as main process console output is not captured by `browser_console_messages`. |

**Reproduction:**
1. Launch app
2. Add watch directory `/tmp/duckspace-qa/test-data` (contains .csv, .json, .tsv files)
3. Wait 10+ seconds
4. Source count stays at "0 sources", no data sources appear in sidebar

**Investigation performed:**
- Verified built code has correct chokidar setup (`ignoreInitial: false`, `awaitWriteFinish: { stabilityThreshold: 2000 }`)
- Verified `ALL_FORMATS` includes all 7 format types
- Verified `formatFilterToExtensions` correctly maps formats to file extensions
- Verified `EXTENSION_TO_FORMAT` includes csv, tsv, json, etc.
- Verified startup sequence correctly calls `fileWatcherInstance.setMainWindow(mainWindow)` before `setFileWatcher`
- Verified `ingestionRouter` frozen object has `importFiles` export
- Verified `setWorker`, `setMainWindow`, `setIngestionReady` all called in correct order
- Verified chokidar v4.0.3 has CJS exports (`"require": "./index.js"`)
- Standalone chokidar test (`node -e "require('chokidar').watch(...)..."`) fires events correctly
- `electron_evaluate` sandbox cannot access `require()` or `process.mainModule` to inspect runtime state

**Possible causes (needs dev investigation with visible main process logs):**
- chokidar event loop interaction with Electron main process
- `awaitWriteFinish` polling behavior in bundled code context
- `emitWatchFileEvent` silently dropping events if `this.mainWindow` is somehow null/destroyed
- `importFiles` throwing "Worker not initialized" caught by `.catch` (invisible in renderer console)
- Vite bundling issue with `chokidar` external — potential module resolution mismatch at runtime

### P2 (Significant)

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| 4 | Error messages leak internal IPC details | `WatchDirConfig.tsx:100` | Error banner shows raw: "Error invoking remote method 'watch:addDirectory': DuckspaceError: Directory is already being watched: ..." Should strip "Error invoking remote method..." prefix for user-friendly messages. |
| 5 | No confirmation dialog on Remove | `CatalogSidebar.tsx:85-91` | `handleRemoveSource` immediately deletes without "Are you sure?" confirmation. Accidental clicks permanently destroy data source + DuckDB table. |
| 6 | Remove error silently swallowed | `CatalogSidebar.tsx:87-90` | `void (async () => { await removeSource(); await db.delete() })()` has no `.catch()`. If IPC fails, error is lost with no UI feedback. |
| 7 | Retry creates duplicate data source | `CatalogSidebar.tsx:94-97` | `handleRetryImport` calls `importFiles([source.filePath], 'retry')` without passing `dataSourceId`. IPC handler requires `args.dataSourceId !== undefined` to route to `retryImport()`. Without it, falls through to `importFiles()` which creates a NEW data source instead of updating the existing one. |
| 8 | sourceCount only increments, never decrements | `App.tsx:296-308` | `onFileEvent` handler processes `'add'` events to increment `sourceCount` but never handles `'unlink'` events to decrement. Watch directory always shows cumulative count. |
| 9 | Watch directories not restored on restart | `lifecycle.ts:220-222` | `new FileWatcher()` is created during startup but no code reads watch directories from Dexie/IndexedDB to restore previously configured watchers. All watch configs are lost on app restart. |

### P3 (Minor)

| # | Issue | Location | Description |
|---|-------|----------|-------------|
| 10 | Context menu no arrow-key navigation | `CatalogSidebar.tsx:232-234` | `role="menu"` element only handles Escape in `onKeyDown`. WAI-ARIA requires ArrowUp/ArrowDown for menu navigation. |
| 11 | Context menu viewport overflow | `CatalogSidebar.tsx:225-228` | Menu positioned at `{ top: e.clientY, left: e.clientX }` with no bounds check. Right-clicking near bottom or right edge clips menu off-screen. |
| 12 | Format toggle has no aria-pressed | `WatchDirConfig.tsx:196-209` | Format filter buttons toggle visually but lack `aria-pressed` attribute to communicate state to assistive technology. |

---

## Test Results

### Phase 1: Launch + Initial State
| Test | Result | Notes |
|------|--------|-------|
| App launches without crash | PASS | After Dexie v3 schema fix |
| TabBar, StatusBar, CatalogSidebar rendered | PASS | |
| DuckDB worker status "ready" | PASS | Visible in StatusBar |
| No console errors on startup | PASS | Only expected Vite HMR + CSP warning |

### Phase 2: US4 -- WatchDirConfig UI

| Test | Result | Notes |
|------|--------|-------|
| 2a. Empty state rendering | PASS | "No watch directories configured." + hint text + "+ Add" button |
| 2a. `aria-label="Watch Directories"` | PASS | `region` role with correct label |
| 2b. Form appears on "+ Add" click | PASS | Path input, checkboxes, format buttons, Cancel/Add shown |
| 2b. Default state: recursive=checked, auto-reingest=unchecked | PASS | |
| 2b. No format filters selected by default | PASS | |
| 2b. Format toggle (CSV, JSON) activates visually | PASS | Blue highlight on selected buttons (screenshot 06) |
| 2b. Cancel closes form and resets state | PASS | Form hidden, error cleared, "+ Add" reappears |
| 2b. Reopening form restores defaults | PASS | |
| 2c. Empty path validation | PASS | "Directory path is required." with `role="alert"` |
| 2c. Non-existent path error | PASS | "DuckspaceError: Directory not found: ..." with `role="alert"` |
| 2c. File path (not directory) error | PASS | "DuckspaceError: Path is not a directory: ..." with `role="alert"` |
| 2d. Successful add (default options) | PASS | Entry shows green dot, "test-data" name, full path, "0 sources", all format badges, "recursive" tag |
| 2d. Form closes after success | PASS | "+ Add" button reappears |
| 2e. Duplicate directory rejection | PASS | "DuckspaceError: Directory is already being watched: ..." |
| 2f. Remove directory | PASS | Entry removed, empty state returns |
| 2f. Remove button `aria-label` | PASS | "Remove watch directory test-data" |
| 2g. Add with format filters (CSV+JSON) | PASS | Entry shows "CSV, JSON" filter text |
| 2h. Add with auto-reingest | PASS | "auto-reingest" tag badge displayed |
| 2h. Recursive tag retained | PASS | Both "recursive" and "auto-reingest" tags shown |

### Phase 3: US4 -- File Event Handling

| Test | Result | Notes |
|------|--------|-------|
| 3a. Auto-ingest on file discovery | **FAIL (P1)** | Source count stays at 0. No data sources created. See Issue #3. |
| 3b. Nested file discovery | BLOCKED | Depends on 3a |
| 3c. Unsupported extensions ignored | BLOCKED | Depends on 3a |
| 3d. Source count accuracy | **FAIL (P1)** | Always shows 0 |

### Phase 4: US5 -- Data Source Display + Context Menu

| Test | Result | Notes |
|------|--------|-------|
| 4a. Source list rendering | BLOCKED | No data sources available (native file dialog cannot be automated, file watcher P1 prevents auto-ingest) |
| 4b. Source click opens data grid tab | BLOCKED | |
| 4c. Non-active source click is no-op | BLOCKED | |
| 4d. Empty state ("No data sources yet.") | PASS | Correct text + "Import files" button + drag & drop hint |
| 5a. Context menu opens on right-click | BLOCKED | No data sources to right-click |
| 5b-5f. All context menu tests | BLOCKED | |

**Code review findings (not live-tested):**
- Context menu has `role="menu"`, `aria-label="Source actions"`, items have `role="menuitem"` -- correct ARIA
- "Copy Table Name" only shown when `tableName != null` -- correct
- "Retry Import" only shown when status is `error` or `stale` -- correct
- "Remove" shown for all sources -- correct
- Escape key dismisses menu -- correct
- Click outside dismisses menu -- correct
- Arrow-key navigation missing -- P3 issue #10

### Phase 5: Accessibility + Edge Cases

| Test | Result | Notes |
|------|--------|-------|
| `aria-label` on section landmarks | PASS | "Data Sources" on sidebar, "Watch Directories" on section |
| Status dot `role="img"` with label | PASS | `aria-label="Status: active"` |
| Error banner `role="alert"` | PASS | All error messages use `role="alert"` |
| `htmlFor`/`id` on path input | PASS | `htmlFor="watch-dir-path"` matches `id="watch-dir-path"` |
| Skip-to-content link | PASS | "Skip to main content" link present |
| Responsive at 800x600 | PASS | Sidebar and content scale properly |
| Responsive at 1920x1080 | PASS | Sidebar maintains fixed width, content stretches |
| No console errors | PASS | Only expected dev warnings (Vite HMR, CSP, React DevTools) |
| No external network requests | PASS | All requests to localhost:5173 |
| Missing `aria-pressed` on format toggles | FAIL (P3) | Buttons toggle visually but lack `aria-pressed` for AT |
| Context menu missing arrow-key nav | FAIL (P3) | Only Escape handled, no Up/Down arrow for `role="menu"` |

---

## Screenshots

| # | Description | File |
|---|-------------|------|
| 1 | Initial state (clean launch) | `01-initial-state.png` |
| 2 | Successful add directory | `04-add-directory-success.png` |
| 3 | Duplicate directory error | `05-duplicate-directory-error.png` |
| 4 | Format filter toggle (CSV+JSON selected) | `06-format-filter-toggle.png` |
| 5 | Remove directory -> empty state | `07-remove-directory-empty-state.png` |
| 6 | Add with filters + auto-reingest | `08-add-with-filters-and-autoreingest.png` |
| 7 | Responsive 800x600 | `09-responsive-800x600.png` |
| 8 | Responsive 1920x1080 | `10-responsive-1920x1080.png` |

---

## Testing Limitations

1. **Native file dialog:** Electron's `dialog.showOpenDialog()` cannot be automated via Playwright MCP. The `browser_file_upload` tool only works with HTML file inputs, not native OS dialogs. This blocked all manual import testing and consequently all context menu testing.

2. **Main process console:** `browser_console_messages` only captures renderer process output. FileWatcher runs in the main process, so its console.log/console.error output is invisible. This severely limited P1 bug investigation.

3. **`electron_evaluate` sandbox:** Runs in a utility script context without `require()`, `import()`, or `process.mainModule` access. Cannot inspect main process module state, global variables, or call functions on loaded modules.

4. **Build staleness:** `.vite/build/main-entry.js` is NOT hot-reloaded during development. Changes to main process code (ipc-handlers.ts, lifecycle.ts, file-watcher.ts, ingestion-router.ts) require manual rebuild. The Vite dev server only HMRs renderer code. This was the root cause of the P0 stale-handler bug.

---

## Recommendations

### Immediate (before merge)
1. **Investigate P1 file watcher bug** -- Add file-based logging to FileWatcher methods (`addDirectory`, `handleAdd`, `emitWatchFileEvent`) and test with `electron-forge start` where stdout is visible.
2. **Fix P2 error message leakage (#4)** -- Strip "Error invoking remote method..." prefix in WatchDirConfig error handler.
3. **Fix P2 retry duplicate (#7)** -- Pass `dataSourceId` to `importFiles` when trigger is `'retry'` so the IPC handler routes to `retryImport`.

### Short-term
4. **Add Remove confirmation (#5)** -- At minimum a native `confirm()` dialog before permanent deletion.
5. **Add error handling to Remove (#6)** -- Wrap `handleRemoveSource` async IIFE in `.catch()` with error state.
6. **Fix sourceCount decrement (#8)** -- Handle `'unlink'` events in `App.tsx` `onFileEvent` listener.
7. **Add watch directory persistence (#9)** -- Read `watch_directories` from Dexie on startup and call `fileWatcher.addDirectory()` for each active entry.

### Quality improvements
8. **Add `aria-pressed` to format toggles (#12)** -- Communicate toggle state to assistive technology.
9. **Add arrow-key navigation to context menu (#10)** -- Required by WAI-ARIA `role="menu"` spec.
10. **Add viewport bounds check to context menu (#11)** -- Prevent clipping at window edges.

---

## Verification

- Unit tests: **698/698 PASS** (39 files, 2.23s)
- Type errors: **none**
- Console errors: **none** (renderer)
- Network: **localhost only** (no external requests)
