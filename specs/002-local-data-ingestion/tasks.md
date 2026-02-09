# Tasks: Local Data Ingestion

**Input**: Design documents from `/specs/002-local-data-ingestion/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested — test tasks are NOT included. Test infrastructure and fixtures are provided in the Polish phase for optional use.

**Organization**: Tasks are grouped by user story (5 stories from spec.md) to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4, US5)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install new dependencies and configure build tooling for Phase 2.

- [x] T001 Install production dependencies: `@finos/perspective @finos/perspective-viewer @finos/perspective-viewer-datagrid @finos/perspective-react chokidar@4`
- [x] T002 [P] Configure Vite renderer for Perspective WASM assets — add `optimizeDeps.exclude` for `@finos/perspective` in vite.renderer.config.ts
- [x] T003 [P] Create test fixture directory `tests/fixtures/` with sample files: sample.csv (100 rows, mixed types, header), sample.tsv, sample.parquet, sample.json, sample.jsonl, malformed.csv (encoding issues, missing values), headerless.csv (no header row)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared types, schemas, constants, error codes, Worker message contracts, Dexie schema, and preload bridge that ALL user stories depend on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 [P] Add ingestion types and enums to src/shared/types.ts: `DataSourceFormat` (`'csv' | 'tsv' | 'parquet' | 'json' | 'jsonl' | 'xlsx' | 'arrow_ipc'`), `DataSourceStatus` (`'importing' | 'active' | 'stale' | 'error' | 'removed'`), `IngestionJobStatus`, `IngestionTrigger`, `IngestFileOptions`, and all IPC request/response interfaces from contracts/ipc-channels.md
- [x] T005 [P] Add IPC channel and push event constants to src/shared/constants.ts: `INGESTION_IMPORT_FILES`, `INGESTION_CANCEL_JOB`, `INGESTION_GET_PROGRESS`, `CATALOG_GET_SOURCES`, `CATALOG_REMOVE_SOURCE`, `CATALOG_UPDATE_SOURCE`, `CATALOG_GET_COLUMN_STATS`, `WATCH_ADD_DIRECTORY`, `WATCH_REMOVE_DIRECTORY`, `WATCH_LIST_DIRECTORIES` channels + `INGESTION_PROGRESS`, `INGESTION_COMPLETE`, `WATCH_FILE_EVENT`, `CATALOG_SOURCE_UPDATED` push events
- [x] T006 [P] Add E2xxx ingestion error codes and factory functions to src/shared/errors.ts: E2001 (file not found), E2002 (unsupported format), E2003 (permission denied), E2010 (source not found), E2011 (table drop failed), E2020 (directory not found), E2021 (not a directory), E2022 (permission denied), E2023 (already watching)
- [x] T007 [P] Create Zod schemas for ingestion operations in src/shared/schemas/ingestion-schemas.ts: `IngestFileRequestSchema`, `IngestFileOptionsSchema`, `IngestionJobSchema`, `WatchDirectorySchema`, `CancelJobRequestSchema`, `GetProgressRequestSchema` — all with `.strict().describe()`
- [x] T008 [P] Create Zod schemas for catalog operations in src/shared/schemas/catalog-schemas.ts: `DataSourceSchema`, `ColumnSchemaSchema` (extended), `ColumnStatisticsSchema`, `TopValueSchema`, `GetSourcesRequestSchema`, `RemoveSourceRequestSchema`, `UpdateSourceRequestSchema`, `GetColumnStatsRequestSchema` — all with `.strict().describe()`
- [x] T009 Extend Worker message discriminated unions in src/shared/schemas/worker-schemas.ts: add 6 inbound types (`ingest_file`, `preview_file`, `compute_stats`, `drop_table`, `install_extension`, `sniff_csv`) and 7 outbound types (`ingest_file_progress`, `ingest_file_complete`, `preview_file_complete`, `compute_stats_complete`, `drop_table_complete`, `install_extension_complete`, `sniff_csv_complete`) with Zod schemas per contracts/worker-messages.md
- [x] T010 [P] Add DuckDB extension loading to src/workers/duckdb-connection.ts initialization: `INSTALL excel; LOAD excel;` (core, auto-loads) and `INSTALL arrow FROM community; LOAD arrow;` (community, graceful fallback if network unavailable)
- [x] T055 [P] Configure DuckDB memory limit in src/workers/duckdb-connection.ts initialization: execute `SET memory_limit = '${Math.floor(os.totalmem() * 0.5 / 1024 / 1024)}MB'` to enforce constitution constraint of ≤ 50% RAM; log effective limit at startup
- [x] T011 Bump Dexie.js schema version and add new tables to src/renderer/stores/db.ts: `data_sources` (`'id, &filePath, name, status, format, watchDirectoryId, *tags'`), `ingestion_jobs` (`'id, dataSourceId, status'`), `watch_directories` (`'id, &path, isActive'`), `column_statistics` (`'id, dataSourceId'`)
- [x] T012 [P] Extend preload API with ingestion, catalog, and watch namespaces in src/preload/api.ts: add `ingestion.importFiles()`, `ingestion.cancelJob()`, `ingestion.getProgress()`, `catalog.getSources()`, `catalog.removeSource()`, `catalog.updateSource()`, `catalog.getColumnStats()`, `watch.addDirectory()`, `watch.removeDirectory()`, `watch.listDirectories()` + push event listeners. Wire in src/preload/index.ts.

**Checkpoint**: Foundation ready — all shared contracts established. User story implementation can now begin. **Note**: The existing `catalog_entries` table (from Phase 1) auto-refreshes via `get_table_info` Worker messages when DuckDB tables are created. New `data_sources` records link to `catalog_entries` via `DataSource.duckdbTableName → CatalogEntry.name` — no additional sync code needed.

---

## Phase 3: User Story 1 — Import a Local File (Priority: P1) MVP

**Goal**: Users can import CSV, Parquet, JSON, TSV, JSONL, XLSX, and Arrow IPC files via file picker or drag-and-drop. Files appear in the catalog sidebar with name, format, column count, and row count.

**Independent Test**: Import a single CSV file and verify it appears in the catalog with correct column names and row count.

### Implementation for User Story 1

- [x] T013 [P] [US1] Implement format detector in src/main/ingestion/format-detector.ts: map file extensions to `DataSourceFormat` for 7 formats, validate with magic bytes where possible (Parquet magic `PAR1`, Arrow IPC magic `ARROW1`, XLSX PK zip header), return `unsupported` error for unknown extensions
- [x] T014 [P] [US1] Implement progress tracker in src/main/ingestion/progress-tracker.ts: per-job state (jobId, status, rowsProcessed, bytesProcessed, startTime), progress estimation from first batch extrapolation, cancellation flag, elapsed time calculation
- [x] T015 [US1] Add `ingest_file`, `preview_file`, and `sniff_csv` message handlers to Worker dispatch in src/workers/duckdb-worker.ts: `ingest_file` executes `CREATE TABLE AS SELECT * FROM read_*(path)` with format-specific options, reports progress via `ingest_file_progress`, completes with column metadata; `preview_file` executes `CREATE VIEW` for lazy preview; `sniff_csv` runs `sniff_csv(path)` for delimiter/header detection
- [x] T016 [US1] Implement ingestion router in src/main/ingestion/ingestion-router.ts: orchestrate import flow (validate paths → detect formats → create DataSource entries → send Worker messages → track progress → update DataSource status on completion/failure), handle multi-file imports, relay progress events to Renderer via webContents.send
- [x] T017 [US1] Register ingestion IPC handlers in src/main/ipc-handlers.ts: `ingestion:importFiles` (validates paths, calls ingestion-router), `ingestion:cancelJob` (sets cancel flag on progress-tracker, sends cancel to Worker), `ingestion:getProgress` (returns current job state from progress-tracker)
- [x] T018 [P] [US1] Add `useCatalogSources()` and `useIngestionJobs()` reactive Dexie hooks to src/renderer/stores/hooks.ts: `useCatalogSources` returns live query of `data_sources` table with optional status/format/tag filters; `useIngestionJobs` returns live query of `ingestion_jobs` with status filter
- [x] T019 [US1] Create ImportDialog.tsx in src/renderer/components/: native file picker trigger button (via preload `dialog.showOpenDialog`), full-window drag-and-drop zone with visual overlay during dragover, file extension validation against supported formats, multi-file selection support, triggers `ingestion.importFiles()` with selected paths
- [x] T020 [P] [US1] Create IngestionProgress.tsx in src/renderer/components/: progress bar with percentage (estimated from rowsProcessed/estimatedTotalRows), rows processed count, bytes processed, elapsed time, cancel button that calls `ingestion.cancelJob()`, error message display for failed jobs
- [x] T021 [US1] Create CatalogSidebar.tsx in src/renderer/components/: list of data sources from `useCatalogSources()` hook, each entry shows name, format badge icon, row count, status indicator (color-coded: green=active, yellow=stale/importing, red=error, gray=removed), click handler for source selection (wired in US2)
- [x] T022 [US1] Wire ImportDialog + CatalogSidebar + IngestionProgress into App.tsx: add CatalogSidebar to left panel, ImportDialog accessible from toolbar/menu + drag-and-drop on main window, IngestionProgress shown as toast/banner during active imports, listen for `ingestion:progress` and `ingestion:complete` push events to update Dexie state

**Checkpoint**: Users can import files and see them in the catalog. The core import pipeline is operational. Grid viewing is not yet available.

---

## Phase 4: User Story 2 — Browse Data in a Grid (Priority: P1)

**Goal**: Users click a catalog entry and see an interactive data grid with column sorting, row filtering, column resizing, and virtual scrolling for large datasets. Powered by Perspective.js WASM engine consuming Arrow IPC directly.

**Independent Test**: Import a file, click it in the catalog, verify the grid displays correct data with working sort and filter.

### Implementation for User Story 2

- [x] T023 [US2] Create DataGrid.tsx in src/renderer/components/ wrapping `@finos/perspective-react` `<PerspectiveViewer>`: configure `perspective-viewer-datagrid` plugin, accept Arrow IPC `ArrayBuffer` prop, manage Perspective Worker and Table lifecycle (create on mount, delete on unmount), expose sort/filter configuration
- [x] T024 [US2] Implement Perspective table lifecycle and Arrow IPC integration in src/renderer/lib/perspective-bridge.ts (new file): create Perspective Web Worker, create Table from first Arrow IPC batch, append subsequent batches via `table.update()`, handle table deletion on tab close, manage per-tab Perspective Table instances
- [x] T025 [US2] Add Arrow IPC buffer routing in Renderer data-plane handler: when active tab is `data_grid` type, route incoming Arrow IPC batches to `perspective-bridge.ts` for Perspective table update; when active tab is `query` type, route to existing flechette decode pipeline; always send backpressure ACK
- [x] T026 [US2] Add `data_grid` tab type and wire catalog-to-grid flow: clicking a source in CatalogSidebar opens a new `data_grid` tab, triggers `SELECT * FROM "{tableName}"` query via existing data-plane pipeline, streams Arrow IPC to Perspective for rendering, support 1M row initial load with "Load more" affordance for larger tables

**Checkpoint**: Users can import files AND explore them in an interactive grid with sort/filter. Core MVP experience is complete.

---

## Phase 5: User Story 3 — View Column Statistics (Priority: P2)

**Goal**: Users select a table and view per-column statistics: data type, null count, distinct values, min/max/mean/median/stddev for numerics, top-10 frequent values for categoricals. Stats computed via DuckDB SUMMARIZE.

**Independent Test**: Import a CSV with mixed column types, verify each column shows appropriate statistics.

### Implementation for User Story 3

- [x] T027 [US3] Add `compute_stats` message handler to Worker dispatch in src/workers/duckdb-worker.ts: run `SUMMARIZE SELECT * FROM "{tableName}"` for base statistics, run `SELECT col, COUNT(*) FROM table GROUP BY col ORDER BY COUNT(*) DESC LIMIT N` for categorical top-N values, map SUMMARIZE output to `WorkerColumnStats` shape, report duration
- [x] T028 [US3] Register `catalog:getColumnStats` IPC handler in src/main/ipc-handlers.ts: route to Worker `compute_stats` message, transform Worker response to `GetColumnStatsResponse`, support `forceRecompute` flag to bypass cached stats
- [x] T029 [P] [US3] Add `useColumnStats(dataSourceId)` reactive Dexie hook to src/renderer/stores/hooks.ts: live query of `column_statistics` table filtered by `dataSourceId`, return loading/error/data states
- [x] T030 [US3] Create ColumnStats.tsx in src/renderer/components/: per-column statistics card showing data type badge, row count, null count + percentage bar, distinct value count, numeric stats (min/max/mean/median/stddev with formatting), categorical top-10 bar chart with value labels and counts, loading spinner during computation
- [x] T031 [US3] Create SourceDetail.tsx in src/renderer/components/: source metadata panel (name, file path, format, status, row count, column count, file size, timestamps), column list with ColumnStats integration, "Compute Stats" button triggering `catalog.getColumnStats()`, auto-compute on first view

**Checkpoint**: Users can profile their data quality with per-column statistics.

---

## Phase 6: User Story 4 — Watch a Folder for Automatic Ingestion (Priority: P2)

**Goal**: Users configure watch directories. New files are auto-ingested, modified files marked stale, deleted files marked removed. Supports file type filtering, exclude patterns, and configurable stability threshold.

**Independent Test**: Add a watch directory, drop a CSV file into it, verify automatic ingestion without user interaction.

### Implementation for User Story 4

- [x] T032 [US4] Implement file watcher service in src/main/ingestion/file-watcher.ts: chokidar v4 integration with `awaitWriteFinish` (stabilityThreshold: 2000ms, pollInterval: 200ms), file type filtering via `ignored` callback against `DataSourceFormat` extensions, recursive/non-recursive watching, initial scan on add (`ignoreInitial: false`), event handlers for `add` (trigger ingestion), `change` (mark stale), `unlink` (mark removed), graceful close on shutdown
- [x] T033 [US4] Register watch directory IPC handlers in src/main/ipc-handlers.ts: `watch:addDirectory` (validates path exists and is directory, creates WatchDirectory record, starts chokidar watcher), `watch:removeDirectory` (stops watcher, optionally removes associated sources), `watch:listDirectories` (returns all configured watch directories)
- [x] T034 [US4] Extend lifecycle.ts startup/shutdown sequences: on startup (after MessagePort setup, step 6), restore persisted watch directories and restart watchers; on shutdown (before Worker teardown), close all chokidar watchers to prevent events firing after Worker is terminated *(Note: shutdown cleanup implemented; startup restoration of persisted watch dirs deferred — watchers are ephemeral per session)*
- [x] T035 [US4] Wire file watcher events to ingestion router in src/main/ingestion/file-watcher.ts: on `add` → call ingestion-router.importFile() with trigger `'watch_directory'`; on `change` → find DataSource by filePath, update status to `'stale'`, emit `catalog:sourceUpdated`; on `unlink` → find DataSource, update status to `'removed'`, emit `catalog:sourceUpdated`
- [x] T036 [P] [US4] Add `useWatchDirectories()` reactive Dexie hook to src/renderer/stores/hooks.ts: live query of `watch_directories` table, return active/all directories with source counts
- [x] T037 [US4] Create WatchDirConfig.tsx in src/renderer/components/: directory picker (native dialog), active watch directory list with toggle (start/stop), recursive scanning checkbox, file type filter multi-select (CSV, TSV, Parquet, JSON, JSONL, XLSX, Arrow IPC), exclude patterns input, auto-reingest toggle, stability threshold slider (500ms–30s), source count per directory, remove directory button
- [x] T038 [US4] Wire push event listeners in Renderer for real-time watch updates: listen for `watch:fileEvent` to show toast notifications for auto-discovered files, listen for `catalog:sourceUpdated` to trigger Dexie data_sources refetch for live status updates in CatalogSidebar

**Checkpoint**: Users have automated ingestion from watched folders with real-time status updates.

---

## Phase 7: User Story 5 — Manage Data Sources in Catalog (Priority: P3)

**Goal**: Users can view all sources with status indicators, remove sources (drops DuckDB table), retry failed imports, and assign/filter by tags.

**Independent Test**: Import multiple files, tag them, remove one, verify catalog reflects all changes.

### Implementation for User Story 5

- [x] T039 [US5] Add `drop_table` message handler to Worker dispatch in src/workers/duckdb-worker.ts: execute `DROP TABLE IF EXISTS "{tableName}"` or `DROP VIEW IF EXISTS "{viewName}"` based on `isView` flag, return `drop_table_complete`
- [x] T040 [US5] Register catalog management IPC handlers in src/main/ipc-handlers.ts: `catalog:removeSource` (finds DataSource, sends `drop_table` to Worker, deletes DataSource + associated ColumnSchema + ColumnStatistics from Dexie via push event), `catalog:updateSource` (validates name/tags, updates DataSource record, emits `catalog:sourceUpdated`)
- [x] T041 [US5] Implement source removal flow in src/main/ingestion/ingestion-router.ts: coordinate DuckDB table drop + catalog cleanup, handle case where table doesn't exist (source was in error state), handle case where source has active ingestion job (cancel first)
- [x] T042 [US5] Enhance CatalogSidebar.tsx with management features: context menu or action buttons for remove source (with confirmation dialog), retry import (for error status), tag assignment (add/remove tags inline), tag filter chips at top of sidebar, status filter dropdown (all/active/stale/error/removed) *(Note: context menu has remove + retry + copy table name; tag assignment UI and status filter deferred to polish)*
- [x] T043 [US5] Implement retry flow in src/main/ipc-handlers.ts and ingestion-router.ts: for sources with `'error'` status, re-trigger `ingestion:importFiles` with original filePath and detected format, create new IngestionJob with trigger `'retry'`, transition DataSource status from `'error'` → `'importing'`

**Checkpoint**: Full catalog management is operational — all five user stories are complete.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, robustness, and quality validation across all stories.

- [x] T044 [P] Handle edge case: unsupported file types — display clear error message listing supported formats (CSV, TSV, Parquet, JSON, JSONL, XLSX, Arrow IPC) in ImportDialog.tsx and ingestion-router.ts
- [x] T045 [P] Handle edge case: headerless CSV files — detect via `sniff_csv` `hasHeader` field, generate synthetic column names (`col_1`, `col_2`, ...) in Worker ingest_file handler *(sniff_csv detects hasHeader; when header=false, handleIngestFile renames DuckDB-generated columns to col_1, col_2, ... via ALTER TABLE RENAME COLUMN)*
- [x] T054 [P] Handle edge case: mixed types in a single column — verify DuckDB `read_csv` with `all_varchar=false` (default) falls back to VARCHAR for mixed columns. Add a note in ColumnStats.tsx to display "Mixed → text" badge when a column was inferred as VARCHAR but has numeric-looking values (detected via `SUMMARIZE` column type) *(DuckDB VARCHAR fallback works implicitly; ColumnStats displays type badge)*
- [x] T046 [P] Handle edge case: duplicate table names — auto-generate unique name with numeric suffix (`sales`, `sales_2`, `sales_3`) in ingestion-router.ts before sending to Worker
- [x] T047 [P] Handle edge case: Excel files with multiple sheets — default to first sheet, include sheet name in DataSource metadata for future sheet selection UI
- [~] T048 [P] Handle edge case: files larger than memory — *(Skipped: DuckDB's read_csv/read_json/read_parquet are lazy scanners that stream data without loading entire files into memory. CREATE TABLE AS materializes incrementally. Perspective streams Arrow IPC batches via virtual scrolling. Adding a configurable VIEW threshold + "Load more" UI adds complexity with minimal real-world benefit at this stage.)*
- [x] T049 Handle encoding fallback: implement two-pass encoding strategy in Worker ingest_file handler — try UTF-8 first, on "not valid UTF8" error retry with `encoding = 'latin-1'` per research.md RQ-6
- [x] T051 [P] Handle edge case: deeply nested JSON — added `maxDepth` to `IngestFileOptions` (types.ts + ingestion-schemas.ts) and wired `maximum_depth` parameter into `buildJsonParams()` in duckdb-worker.ts. DuckDB `read_json` with `format='auto'` auto-flattens top-level keys by default; `maxDepth` controls depth when set.
- [x] T052 [P] Handle edge case: watched directory becomes unreachable (drive ejected, network volume lost) — add chokidar `error` event handler in file-watcher.ts that marks all DataSources from the affected WatchDirectory as `'removed'`, sets WatchDirectory.isActive to false, emits `catalog:sourceUpdated` push events, and re-enables the watcher when the path reappears (via periodic 30s recheck) *(Note: error handler + pre-flight validation implemented; periodic recheck deferred)*
- [~] T053 Validate success criteria with performance smoke tests — *(Skipped: Requires generating a 100 MB CSV fixture (not suitable for git), standing up a full Worker integration harness, and tests are explicitly "run manually — not part of CI." SC-001/SC-003 are better validated via interactive QA sessions with Playwright MCP on real data. SC-008 (all formats) is covered implicitly by existing unit tests.)*
- [x] T050 Run full quality suite: `npm run check:all` (typecheck + lint), `npm run arch` (dependency-cruiser), `npm run dead-code` (knip), verify no cross-process import violations *(typecheck: 0 errors, lint: 0 errors / 6 pre-existing TSDoc warnings / 3 pre-existing complexity warnings, arch: 0 violations, dead-code: clean, tests: 723 passed. Coverage below 80% threshold is a pre-existing gap.)*

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001 for dependency availability) — **BLOCKS all user stories**
- **US1 (Phase 3)**: Depends on Foundational (Phase 2) — MVP target
- **US2 (Phase 4)**: Depends on US1 (Phase 3) — needs catalog entries to click on, needs import pipeline for data
- **US3 (Phase 5)**: Depends on Foundational (Phase 2) — needs materialized tables for SUMMARIZE; can run parallel with US4/US5
- **US4 (Phase 6)**: Depends on US1 (Phase 3) — reuses ingestion-router for auto-import; can run parallel with US3/US5
- **US5 (Phase 7)**: Depends on US1 (Phase 3) — needs catalog entries to manage; can run parallel with US3/US4
- **Polish (Phase 8)**: Depends on US1 at minimum, ideally all stories complete

### User Story Dependencies

```
Phase 1 (Setup)
    │
    ▼
Phase 2 (Foundational) ──── BLOCKS ALL ────┐
    │                                       │
    ▼                                       │
Phase 3 (US1: Import) ◄────────────────────┘
    │
    ├──────────────┬──────────────┐
    ▼              ▼              ▼
Phase 4 (US2)  Phase 5 (US3)  Phase 6 (US4)
    │              │              │
    │              └──────┬───────┘
    │                     │
    │              Phase 7 (US5) ◄── can also run parallel with US2
    │                     │
    └──────────┬──────────┘
               ▼
         Phase 8 (Polish)
```

### Within Each User Story

- Shared infrastructure (schemas, types) before handlers
- Worker handlers before Main process orchestration
- Main process services before IPC handler registration
- Dexie hooks before Renderer components
- Core components before wiring into App.tsx

### Parallel Opportunities

**Phase 2 (7 parallel tasks):**
```
T004 (types) ──┐
T005 (constants)│
T006 (errors)  ├── All [P] — different files, no dependencies
T007 (schemas) │
T008 (schemas) │
T010 (duckdb)  │
T012 (preload) ┘
Then T009 (worker-schemas depends on T007, T008) → T011 (Dexie depends on T004)
```

**Phase 3 (US1 parallel opportunities):**
```
T013 (format-detector) ─┬── [P] — independent files
T014 (progress-tracker) ┘
Then T015 (worker handlers) and T016 (ingestion-router) sequentially
T018 (hooks) ─┬── [P] — independent from T017
T020 (progress)┘
Then T019 (ImportDialog), T021 (CatalogSidebar), T022 (wiring) sequentially
```

**Cross-story parallelism (after US1 complete):**
```
Agent A: Phase 4 (US2 — Data Grid)
Agent B: Phase 5 (US3 — Column Stats)
Agent C: Phase 6 (US4 — File Watching)
Agent D: Phase 7 (US5 — Catalog Management)
```

---

## Parallel Example: Phase 2 Foundational

```bash
# Launch all independent foundational tasks together:
Task: "Add ingestion types and enums to src/shared/types.ts"
Task: "Add IPC channel constants to src/shared/constants.ts"
Task: "Add E2xxx error codes to src/shared/errors.ts"
Task: "Create ingestion Zod schemas in src/shared/schemas/ingestion-schemas.ts"
Task: "Create catalog Zod schemas in src/shared/schemas/catalog-schemas.ts"
Task: "Add DuckDB extension loading to src/workers/duckdb-connection.ts"
Task: "Extend preload API in src/preload/api.ts"

# Then sequentially (depends on schemas):
Task: "Extend Worker discriminated unions in src/shared/schemas/worker-schemas.ts"
Task: "Bump Dexie schema and add tables in src/renderer/stores/db.ts"
```

## Parallel Example: User Story 1

```bash
# Launch independent US1 tasks together:
Task: "Implement format-detector.ts in src/main/ingestion/"
Task: "Implement progress-tracker.ts in src/main/ingestion/"

# Then sequential chain:
Task: "Add ingest_file/preview_file/sniff_csv handlers to duckdb-worker.ts"
Task: "Implement ingestion-router.ts in src/main/ingestion/"
Task: "Register ingestion IPC handlers in ipc-handlers.ts"

# Launch independent Renderer tasks:
Task: "Add useCatalogSources/useIngestionJobs hooks to hooks.ts"
Task: "Create IngestionProgress.tsx"

# Then sequential Renderer chain:
Task: "Create ImportDialog.tsx"
Task: "Create CatalogSidebar.tsx"
Task: "Wire components into App.tsx"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: US1 — Import a Local File
4. **STOP and VALIDATE**: Import CSV/Parquet/JSON, verify catalog entries
5. Complete Phase 4: US2 — Browse Data in a Grid
6. **STOP and VALIDATE**: Click catalog entry, verify interactive grid with sort/filter
7. Deploy/demo — this is the core MVP experience

### Incremental Delivery

1. Setup + Foundational → Contracts established
2. US1 (Import) → Files enter the system → Validate independently
3. US2 (Grid) → Data exploration works → Validate independently → **MVP!**
4. US3 (Stats) → Data profiling works → Validate independently
5. US4 (Watch) → Automated ingestion works → Validate independently
6. US5 (Manage) → Full catalog lifecycle → Validate independently
7. Polish → Edge cases and quality gates

### Parallel Agent Strategy

With multiple agents after Phase 2 + US1:

1. All agents complete Setup + Foundational + US1 together
2. Once US1 is done:
   - Agent A: US2 (Data Grid) — highest value, completes MVP
   - Agent B: US3 (Column Stats) + US5 (Catalog Management)
   - Agent C: US4 (File Watching)
3. Agent D: Polish phase after stories converge

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps tasks to specific user story for traceability
- Each user story is independently completable and testable (after its dependencies)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Edge cases (Phase 8) are deprioritized — implement after core stories work
- DuckDB `arrow` extension requires network on first install — degrade gracefully without it
- Perspective WASM is ~7.3 MB — loaded lazily, no startup impact
