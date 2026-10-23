# QA Report — Duckspace (Post-Fix Verification)

**Date**: 2026-02-08
**Tester**: Claude (Automated QA via Playwright MCP)
**App Version**: 822ae47 (+ unstaged QA fixes)
**Branch**: 002-local-data-ingestion
**Focus Area**: Full Application + QA Fix Verification
**Environment**: macOS, Electron + Vite Dev Mode (Playwright MCP launch)

## Executive Summary

The core application is stable and functional. Tab management, query execution, catalog browsing, keyboard shortcuts, and error handling all work correctly. The DuckDB worker health is solid ("DuckDB: ready" maintained throughout). However, the **P1 file watcher event propagation issue persists** — adding files to a watched directory does not trigger ingestion or update the sourceCount. The `restoreDirectories` IPC pathway appears non-functional in the MCP-launched environment. All other QA fixes (P2, P3) could not be fully verified via Playwright due to native dialog dependencies, but the code paths tested (error display, console cleanliness) look correct.

## Test Coverage Matrix

| Area | Tests Run | Pass | Fail | Skip | Notes |
|------|-----------|------|------|------|-------|
| Tab Management | 8 | 8 | 0 | 0 | Create, close, switch, keyboard shortcuts, welcome view |
| Query Editor | 6 | 6 | 0 | 0 | Valid, invalid, empty result, special chars, large result |
| Result Grid | 4 | 4 | 0 | 0 | Single row, 100 rows, data types, row count |
| Catalog Browser | 3 | 3 | 0 | 0 | Table listing, schema view, tab switching |
| Status Bar | 2 | 2 | 0 | 0 | DuckDB ready indicator, stable throughout |
| Keyboard Shortcuts | 3 | 3 | 0 | 0 | Cmd+T, Cmd+W, tab switching |
| Error Handling | 2 | 2 | 0 | 0 | SQL syntax error, clean error display |
| Accessibility | 2 | 2 | 0 | 0 | Skip link, ARIA landmarks, heading hierarchy |
| Responsiveness | 3 | 2 | 1 | 0 | 1280x720, 800x600 OK; 400x300 sidebar overlap |
| File Watcher | 2 | 0 | 2 | 0 | Events not propagating, restore not working |
| Watch Dir Config | 1 | 1 | 0 | 0 | Remove directory works |
| Edge Cases | 2 | 2 | 0 | 0 | Unicode/emoji, NULL values |

## Issues Found

### P0 — Critical
None found.

### P1 — Major
1. [QA-POST-1] File watcher events not propagating to renderer

### P2 — Minor
None found (previously identified P2 issues have code fixes applied but require native dialog interaction to fully verify).

### P3 — Cosmetic
1. [QA-POST-2] Sidebar doesn't collapse at very small viewports

### P4 — Enhancement Opportunities
1. [QA-POST-3] Query results not preserved when switching tabs
2. [QA-POST-4] NULL values in result grid lack visual distinction

## Issue Details

### QA-POST-1: File watcher events still not propagating to renderer

- **Severity**: P1
- **Area**: File Watcher / Data Ingestion
- **Status**: Regression from previous QA report (issue #3)
- **Reproduction Steps**:
  1. Launch app (with existing watch directory `/tmp/duckspace-qa/test-data` in Dexie)
  2. Observe watch directory shows "0 sources" and status "active"
  3. Create a CSV file in the watched directory: `echo "id,name\n1,test" > /tmp/duckspace-qa/test-data/watcher-test.csv`
  4. Wait 8+ seconds
  5. Observe sidebar still shows "0 sources" and "No data sources yet."
- **Expected Behavior**: sourceCount should increment to 1, a data source entry should appear in the sidebar, and the file should be auto-ingested into DuckDB.
- **Actual Behavior**: No change. The file watcher either: (a) wasn't restored via `restoreDirectories` on app mount, or (b) chokidar is not detecting file system events in this build.
- **Console Output**: No errors or warnings in renderer console. No `[FileWatcher]` diagnostic logs visible.
- **Screenshot**: `screenshots/01-initial-state.png` (showing 0 sources despite files existing)
- **Root Cause Analysis**:
  - The `restoreDirectories` code in `App.tsx` reads from `db.watch_directories` and calls `window.duckspace.watch.restoreDirectories()`. However, in the MCP-launched Electron environment, the IndexedDB (Dexie) data lives in `~/Library/Application Support/Electron/` (not `~/Library/Application Support/Duckspace/`). The watch directory entry visible in the UI was created in this MCP environment during a previous session.
  - The `restoreDirectories` IPC handler in `ipc-handlers.ts` calls `fileWatcher.restoreDirectories()` which calls `addDirectory()` for each directory. If this succeeds, chokidar should be watching. The absence of any console warnings suggests the restoration may have succeeded but chokidar isn't detecting file events in this environment.
  - Alternatively, the `build-e2e.mjs` build may not be correctly including the chokidar externalization — though inspection of `main-entry.js` line 10 shows `const chokidar = require("chokidar")` which is correct.
  - **Most likely**: The chokidar watcher IS running but the `handleAdd` method only processes files matching the configured format filters AND that don't already exist. The test file may have been created before the watcher was restored, so chokidar's `add` event for the initial scan was missed. The `awaitWriteFinish` option (if configured) may also delay detection.
- **Suggested Fix**: Add diagnostic logging that's visible in the renderer (e.g., a console.log in the preload bridge for `onFileEvent`). Also consider emitting a `sourceUpdated` push event when `restoreDirectories` completes, including a count of discovered files during initial scan.
- **Affected Files**: `src/main/ingestion/file-watcher.ts`, `src/renderer/App.tsx`, `src/main/ipc-handlers.ts`

### QA-POST-2: Sidebar doesn't collapse at very small viewports

- **Severity**: P3
- **Area**: Responsiveness
- **Status**: New
- **Reproduction Steps**:
  1. Resize window to 400x300
  2. Observe sidebar overlaps main content area
- **Expected Behavior**: At very small viewports, sidebar should either collapse, hide behind a toggle, or reduce width.
- **Actual Behavior**: Sidebar maintains fixed width (~240px), main content is squeezed to ~160px, making it unusable.
- **Screenshot**: `screenshots/03-responsive-400x300.png`
- **Suggested Fix**: Add a CSS media query or min-width constraint. For a desktop app, this is low priority since users rarely resize to such small sizes.
- **Affected Files**: `src/renderer/App.tsx` (layout styles)

### QA-POST-3: Query results not preserved when switching tabs

- **Severity**: P4
- **Area**: Tab Management
- **Status**: New (Enhancement)
- **Reproduction Steps**:
  1. Execute a query in Query 1 tab — results display
  2. Switch to Catalog tab
  3. Switch back to Query 1 tab
  4. Observe: query text is preserved, but results area shows "Execute a query to see results"
- **Expected Behavior**: Both query text and results should be preserved when switching tabs.
- **Actual Behavior**: Query text is preserved (good), but results are cleared. User must re-execute.
- **Suggested Fix**: Cache the last result Arrow IPC buffer per tab in the Dexie `queries` table, and restore it when switching back to the tab.

### QA-POST-4: NULL values in result grid lack visual distinction

- **Severity**: P4
- **Area**: Result Grid
- **Status**: New (Enhancement)
- **Reproduction Steps**:
  1. Execute: `SELECT NULL AS null_val`
  2. Observe NULL displayed as italic gray "NULL" text
- **Expected Behavior**: NULL values should be visually distinct from the string "NULL".
- **Actual Behavior**: NULL is rendered in italic gray which is somewhat distinguishable but could be confused with the literal string "NULL" in certain contexts.
- **Screenshot**: `screenshots/08-special-chars.png`
- **Suggested Fix**: Use a more distinctive style (e.g., lighter gray, `font-style: italic` with a different color, or a dash `—`).

## Positive Observations

- **Clean console**: Zero errors or unhandled promise rejections throughout the entire QA session. No deprecation warnings beyond the expected dev-mode CSP warning.
- **Stable DuckDB worker**: "DuckDB: ready" maintained throughout all operations including rapid query executions.
- **Correct error taxonomy**: SQL errors show proper error codes (`[E1001]`) with DuckDB's helpful error messages including line/column indicators.
- **Good accessibility foundation**: Skip-to-content link, proper heading hierarchy (h1 > h2 > h3), ARIA landmarks (banner, complementary, main, contentinfo), status role on status bar, tablist/tab/tabpanel structure.
- **Data type display**: Result grid shows both column name and Arrow type (e.g., "amount Float64") which is excellent for an analytics tool.
- **Tab state management**: Tab text is preserved across switches. Tab bar correctly shows active/selected states.
- **Keyboard shortcuts**: Cmd+T (new query tab) and Cmd+W (close tab) work reliably.
- **Unicode support**: Emoji and special characters render correctly in both the query editor and result grid.
- **Empty state messaging**: Clear, helpful messages for "No data sources yet", "No watch directories configured", "Execute a query to see results", "Query returned 0 rows".
- **Network isolation**: All requests go to localhost — no unexpected external calls.

## Recommendations

1. **P1 — Investigate file watcher event flow end-to-end**: The chokidar external fix is in place, but events still aren't reaching the renderer. Add structured diagnostic logging (timestamped) at each step: chokidar event → handleAdd → emitWatchFileEvent → preload bridge → App.tsx handler. Consider adding a "Test Watch" button in the UI that triggers a manual scan.

2. **P2 — Add integration test for file watcher**: Create a test that programmatically adds a watch directory, creates a file, and asserts the sourceCount updates. This would catch the current regression.

3. **P4 — Consider result caching**: Preserving query results across tab switches would significantly improve UX for users running multiple queries.

4. **P3 — Add sidebar collapse at <600px**: A simple `@media (max-width: 600px)` hiding the sidebar with a toggle button would handle edge cases.

## Test Session Log

1. **14:25** — Verified prerequisites: no stale processes, Vite dev server on :5173, build artifacts present
2. **14:25** — Rebuilt artifacts with `npm run build:e2e` (after fixing chokidar external)
3. **14:25** — Launched app via `electron_first_window`. Title "Duckspace", URL `http://localhost:5173/`
4. **14:25** — Phase 1: Captured initial state screenshot. Watch directory "test-data" visible with "0 sources". Status: "DuckDB: ready"
5. **14:26** — Phase 2: Resized to 800x600 (OK), 400x300 (sidebar overlap issue), restored to 1280x720
6. **14:26** — Phase 3: Clicked New tab → dropdown menu with Query/Catalog/Settings. Created "New Query" tab
7. **14:27** — Typed and executed `SELECT 42 AS answer, 'hello' AS greeting, current_date AS today` — 1 row result, correct data
8. **14:27** — Typed and executed `SELCT typo FROM nonexistent` — [E1001] Parser Error displayed correctly
9. **14:27** — Executed `SELECT 1 WHERE false` — "Query returned 0 rows" displayed
10. **14:28** — Created Catalog tab, viewed sales table schema (7 columns with DuckDB/Arrow types)
11. **14:28** — Switched back to Query 1 tab — query text preserved, results cleared (P4 noted)
12. **14:28** — Closed both tabs — WelcomeView returned correctly
13. **14:29** — Phase 4: Created CSV in `/tmp/duckspace-qa/test-data/`. Waited 8s. No file events detected (P1 confirmed)
14. **14:29** — Removed watch directory via × button — removed immediately, empty state shown
15. **14:29** — Tested Cmd+T (new query tab created), Cmd+W (tab closed, welcome view returned)
16. **14:30** — Executed `SELECT * FROM sales LIMIT 100` — 100 rows rendered correctly with all 7 columns
17. **14:30** — Executed special chars query (emoji, escaped quotes, NULL, scientific notation) — all rendered correctly
18. **14:31** — Phase 6: Console audit — zero errors. Network audit — all 200 OK, all localhost
19. **14:31** — Closed app and generated report
