# Tasks: Electron Foundation (Phase 1)

**Input**: Design documents from `/specs/001-electron-foundation/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md

**Tests**: No test tasks are included. Tests were not explicitly requested in the feature specification. Add test phases per story if TDD is desired.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single Electron app**: `src/main/`, `src/preload/`, `src/renderer/`, `src/workers/`, `src/shared/` at repository root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependency installation, and build toolchain configuration

- [X] T001 Initialize Electron Forge project with Vite TypeScript template in repository root
- [X] T002 Install core dependencies: electron@^33, @duckdb/node-api@^1.4.4, @uwdata/flechette@^2.3.0, react@^18, react-dom@^18, dexie@^4.3.0, dexie-react-hooks
- [X] T003 Install dev dependencies: typescript@^5.4, vitest@^3, @playwright/test@^1.52, @vitejs/plugin-react, @types/react, @types/react-dom, @electron-forge/maker-dmg, @electron-forge/maker-zip
- [X] T004 Create source directory structure: src/main/, src/preload/, src/renderer/components/, src/renderer/stores/, src/renderer/lib/, src/workers/, src/shared/ and tests/unit/, tests/integration/, tests/e2e/
- [X] T005 [P] Configure forge.config.ts with VitePlugin (main + preload + renderer entries), MakerDMG, and MakerZIP per quickstart.md
- [X] T006 [P] Configure tsconfig.json with ES2022 target, bundler module resolution, react-jsx, strict mode, and path aliases (@main, @renderer, @workers, @shared, @preload)
- [X] T007 [P] Configure vite.main.config.ts with rollupOptions externals for @duckdb/node-api and worker_threads
- [X] T008 [P] Configure vite.preload.config.ts for preload script bundling
- [X] T009 [P] Configure vite.renderer.config.ts with @vitejs/plugin-react plugin
- [X] T010 [P] Configure vitest.config.ts with path aliases and test tier includes (unit + integration, exclude e2e)
- [X] T011 [P] Configure playwright.config.ts for E2E tests in tests/e2e/ with 30s timeout
- [X] T012 Configure package.json scripts: start, test, test:watch, test:e2e, make, package, lint per quickstart.md

**Checkpoint**: Project builds and `npm start` launches an empty Electron window

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, infrastructure modules, and cross-process communication that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T013 [P] Define shared TypeScript types (all IPC message interfaces, entity types, QueryHandle, QueryStatus, ArrowBatch, CatalogEntry, ColumnSchema, WorkerHealth, AppState, IPCError, DatspaceConfig) in src/shared/types.ts per contracts/preload-api.md and contracts/ipc-channels.md
- [X] T014 [P] Define channel name constants and config defaults (IPC channel names, timeout values, backpressure window size, health check intervals, default preferences) in src/shared/constants.ts
- [X] T015 [P] Define error taxonomy classes and factory functions (E1001-E1012 database errors, E6001-E6006 system errors) with IPCError structure in src/shared/errors.ts
- [X] T016 Implement ConfigManager: read/write/validate config.json at ~/Library/Application Support/Datspace/config.json, generate defaults on first launch, merge with hardcoded defaults, validate against DatspaceConfig interface in src/main/config.ts per data-model.md JSON Configuration section
- [X] T017 [P] Implement DatspaceDB class with Dexie.js version(1) schema declaring 9 collections (tabs, queries, catalog_entries, column_schemas, query_history, preferences, worker_health, recovery_log, app_state) with all indexes in src/renderer/stores/db.ts per contracts/dexie-schema.md
- [X] T018 [P] Define typed DatspaceAPI interface (QueryNamespace, CatalogNamespace, LifecycleNamespace) in src/preload/api.ts per contracts/preload-api.md
- [X] T019 Implement preload contextBridge: wrap ipcRenderer.invoke for all control-plane channels, handle MessagePort receipt and routing for duckdb-data channel, implement backpressure ACK sending, expose window.datspace API in src/preload/index.ts per contracts/preload-api.md implementation reference
- [X] T020 [P] Implement DuckDB connection manager: DuckDBInstance.create() with config, connection pooling, extension loading (parquet, json, icu), _query_history and _schema_version table creation in src/workers/duckdb-connection.ts per data-model.md DuckDB section
- [X] T021 Implement DuckDB Worker Thread entry: parentPort message routing (execute_query, cancel_query, get_table_info, health_check, shutdown, configure), initialization sequence, data port handling in src/workers/duckdb-worker.ts per contracts/ipc-channels.md Worker Control Messages
- [X] T022 Implement WorkerManager: spawn Worker Thread with resourceLimits (512MB V8 heap), health check interval (60s), heartbeat timeout (5s), consecutive miss tracking, auto-restart logic (up to maxRestartAttempts), status transitions (ready/busy/degraded/restarting/failed) in src/main/worker-manager.ts
- [X] T023 Implement IPC handler registration: register all ipcMain.handle channels from channel registry (query:execute, query:cancel, query:listTables, query:describeTable, catalog:preview, lifecycle:ready, lifecycle:getAppState, lifecycle:shutdownAck, config:get, config:set, config:getAll), create MessageChannelMain for duckdb-data port and distribute to Worker and Renderer in src/main/ipc-handlers.ts per contracts/ipc-channels.md Channel Registry

**Checkpoint**: Foundation ready -- shared types compile, config loads, DuckDB worker spawns and reports 'ready', preload bridge exposes window.datspace, Dexie.js opens IndexedDB

---

## Phase 3: User Story 1 - Launch and See an Interactive Application (Priority: P1) MVP

**Goal**: An analyst launches datspace and within 2 seconds sees a responsive application window with tab bar, sidebar area, main content region, and macOS-native traffic-light buttons.

**Independent Test**: Launch the built application on macOS. Confirm the window appears in <2s, UI is responsive, basic navigation elements (tabs, sidebar) render correctly, Cmd+Q triggers graceful shutdown, and tab state persists across restart.

### Implementation for User Story 1

- [X] T024 [US1] Implement Electron Main Process entry: app.whenReady(), BrowserWindow creation with hiddenInset titleBarStyle, contextIsolation:true, nodeIntegration:false, sandbox:false, preload path, dev server URL vs production file loading, dock integration in src/main/index.ts per quickstart.md
- [X] T024b [US1] Implement single-instance lock via app.requestSingleInstanceLock() in src/main/index.ts: if lock not acquired, focus existing window and quit; prevents concurrent DuckDB file access corruption
- [X] T025 [US1] Implement app lifecycle startup sequence: read config -> spawn DuckDB worker -> wait for worker ready -> create BrowserWindow -> setup MessagePort channels -> wait for renderer ready -> begin health monitoring -> mark app interactive in src/main/lifecycle.ts per data-model.md Data Lifecycle Startup
- [X] T026 [US1] Implement app lifecycle graceful shutdown sequence: stop accepting queries -> send shutdown-prepare to renderer -> wait for shutdownAck (5s timeout) -> shutdown DuckDB worker (CHECKPOINT, close connection, terminate) -> write config -> exit (total <=6s) in src/main/lifecycle.ts per data-model.md Data Lifecycle Shutdown
- [X] T027 [P] [US1] Create renderer entry HTML with root div mount point in src/renderer/index.html
- [X] T028 [P] [US1] Create React app entry point: render App component into root div, initialize Dexie.js, signal lifecycle:ready after bootstrap in src/renderer/index.tsx
- [X] T029 [US1] Implement root App component with layout shell: sidebar region (placeholder), main content region (active tab content), tab bar at top, status bar at bottom in src/renderer/App.tsx
- [X] T030 [US1] Implement useLiveQuery hook wrappers: useTabs(), useActiveTab(), useWorkerHealth(), usePreference(), useAppState() in src/renderer/stores/hooks.ts per contracts/dexie-schema.md Reactive Query Patterns
- [X] T031 [US1] Implement StatusBar component: display DuckDB worker health status (color-coded dot + label), active query count, subscribe to worker:status via onWorkerHealth() in src/renderer/components/StatusBar.tsx
- [X] T032 [US1] Implement basic TabBar component: render tab buttons from useTabs() hook, highlight active tab, tab type icons, wire tab switching (update tabs.active in Dexie.js) in src/renderer/components/TabBar.tsx
- [X] T033 [US1] Implement welcome/empty state component for first-launch experience when no tabs or data exist
- [X] T034 [US1] Wire renderer shutdown handler: listen for shutdown-prepare, flush Dexie.js writes, save window_bounds + last_active_tab_id + shutdown_status='clean' to app_state, call shutdownAck()

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently. App launches in <2s, shows responsive UI shell, macOS traffic-light buttons work, Cmd+Q graceful shutdown works, StatusBar shows worker health.

---

## Phase 4: User Story 2 - Write and Execute a SQL Query (Priority: P1)

**Goal**: An analyst opens a query editor tab, types SQL, executes it, and sees results in a virtual-scrolling data grid. Large datasets stream progressively. Queries can be cancelled.

**Independent Test**: Execute `SELECT 42 AS answer` and confirm results appear in data grid. Execute a query against a pre-registered sample table with 1M+ rows and confirm first rows appear within 1 second with virtual scrolling. Cancel a long-running query and confirm it stops within 1 second.

### Implementation for User Story 2

- [X] T035 [US2] Implement QueryRouter: receive query:execute and query:cancel from IPC handlers, generate queryId (UUID), dispatch WorkerQueryRequest to DuckDB Worker, track active queries, enforce timeout policy (30s default), push QueryStatusEvent to renderer via query:progress in src/main/query-router.ts per contracts/ipc-channels.md
- [X] T036 [US2] Implement Arrow IPC batch production: wrap user SQL in to_arrow_ipc(), adaptive batch sizing (~2MB target), window-based backpressure (window=4, pause on full window, resume on ACK), stream-end and error signaling via duckdb-data MessagePort in src/workers/arrow-stream.ts per contracts/ipc-channels.md Data Plane
- [X] T037 [P] [US2] Implement Flechette Arrow IPC decoder: tableFromIPC() wrapper, extract column names/types/row count, provide column accessor for virtual-scrolling grid in src/renderer/lib/arrow-decode.ts per quickstart.md
- [X] T038 [P] [US2] Implement Renderer-side backpressure flow control: receive Arrow batches on MessagePort, send ACK messages, accumulate decoded batches, handle stream-end and error messages in src/renderer/lib/backpressure.ts per contracts/ipc-channels.md Backpressure Protocol
- [X] T039 [US2] Implement QueryEditor component: SQL text input area, execute button (triggers window.datspace.query.execute()), cancel button (triggers window.datspace.query.cancel()), query status display (phase, elapsed time, batches streamed), subscribe to onStatus() in src/renderer/components/QueryEditor.tsx
- [X] T040 [US2] Implement ResultGrid component: virtual-scrolling data grid rendering decoded Arrow batches, column headers from schema, handle progressive batch arrival, support scrolling through millions of rows at >30fps in src/renderer/components/ResultGrid.tsx
- [X] T041 [US2] Wire query execution end-to-end: QueryEditor execute -> preload query.execute() -> IPC query:execute -> QueryRouter -> Worker execute_query -> to_arrow_ipc() -> MessagePort arrow-batch -> preload onData() -> arrow-decode -> ResultGrid render
- [X] T042 [US2] Implement query cancellation flow: cancel button -> preload query.cancel() -> IPC query:cancel -> QueryRouter -> Worker cancel_query + data-plane cancel message -> confirm no further batches arrive
- [X] T043 [US2] Implement query error handling: catch DuckDB errors, map to error taxonomy codes (E1001 syntax, E1004 table not found, E1007 OOM), send arrow-error on data plane, display human-readable messages in QueryEditor
- [X] T044 [US2] Implement query metadata tracking: create Dexie.js queries record on execute (status:running), update on complete/fail/cancel with rowCount, executionTimeMs, errorCode, errorMessage in src/renderer/stores/hooks.ts

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently. Full query execution pipeline works end-to-end with Arrow IPC data transfer, virtual scrolling, cancellation, and error handling.

---

## Phase 5: User Story 3 - Browse Registered Tables and Schemas (Priority: P2)

**Goal**: An analyst navigates to a catalog browser to see all registered tables, click on a table to view column names/types, and preview sample rows.

**Independent Test**: Register at least one table in DuckDB, open the catalog view, confirm the table appears with accurate column information and row counts. Click preview and confirm sample rows display.

### Implementation for User Story 3

- [X] T045 [US3] Implement catalog IPC handlers in QueryRouter: query:listTables (query information_schema.tables), query:describeTable (query information_schema.columns), catalog:preview (execute SELECT * FROM table LIMIT n via Arrow IPC) in src/main/query-router.ts
- [X] T046 [US3] Implement CatalogSyncBridge: after table registration or catalog:list response, push CatalogEntry + ColumnSchemaRecord data to Renderer via webContents.send, Renderer writes to Dexie.js catalog_entries and column_schemas collections
- [X] T047 [US3] Implement useLiveQuery hooks for catalog: useCatalogEntries() (active entries sorted by name), useColumnSchemas(catalogEntryId) (columns sorted by ordinalPosition) in src/renderer/stores/hooks.ts
- [X] T048 [US3] Implement CatalogBrowser component: table list showing name, type (table/view), row count, column count from useCatalogEntries(), click handler to select table in src/renderer/components/CatalogBrowser.tsx
- [X] T049 [US3] Implement table detail panel within CatalogBrowser: display column names, DuckDB types, Arrow types, nullability from useColumnSchemas(), preview button triggering catalog.previewTable()
- [X] T050 [US3] Implement sample data registration for development and testing: programmatically create sample tables in DuckDB (sales with 1M rows, products with 500 rows) via Worker startup script

**Checkpoint**: At this point, User Stories 1, 2, AND 3 should all be independently functional. Catalog browser shows registered tables with accurate schema information and data previews.

---

## Phase 6: User Story 4 - Recover Gracefully from Errors and Crashes (Priority: P2)

**Goal**: After an unexpected quit, the application relaunches, detects the abnormal shutdown, verifies database integrity, and resumes to a usable state without data loss. Unresponsive workers are automatically restarted.

**Independent Test**: Force-quit the app (kill -9) mid-query, relaunch, confirm recovery_log entry is created, DuckDB integrity check passes, all previously registered tables are still accessible. Also: simulate worker unresponsiveness and confirm auto-restart within 60 seconds.

### Implementation for User Story 4

- [X] T051 [US4] Implement crash detection: on Renderer startup, read app_state['shutdown_status'] from Dexie.js, if 'dirty' or missing trigger recovery flow, always set to 'dirty' on startup and 'clean' on graceful shutdown
- [X] T052 [US4] Implement DuckDB integrity verification: send integrity_check command to Worker (PRAGMA integrity_check), report result to Main Process, log outcome to recovery_log via Renderer
- [X] T053 [US4] Implement recovery log writing: write RecoveryLogEntry records to Dexie.js recovery_log collection for abnormal_shutdown, integrity_check, wal_recovery, and worker_restart events per data-model.md recovery_log schema
- [X] T054 [US4] Implement catalog reconciliation on crash recovery: compare DuckDB information_schema.tables with Dexie.js catalog_entries, create missing entries, mark orphaned entries as 'removed', log reconciliation to recovery_log
- [X] T055 [US4] Implement worker health monitoring integration: WorkerManager sends heartbeat every 60s, tracks consecutive misses, on 2 consecutive misses marks 'degraded' and initiates restart, pushes WorkerHealthEvent to Renderer via worker:status channel
- [X] T056 [US4] Implement automatic worker restart: terminate unresponsive Worker Thread, respawn with same config, re-establish MessagePort channels, update worker_health in Dexie.js, respect maxRestartAttempts (3), mark 'failed' after limit exceeded
- [X] T057 [US4] Implement DuckDB memory configuration: set memory_limit based on config (50% system RAM default), configure temp_directory for spill-to-disk, set Worker Thread V8 heap limit to 512MB via resourceLimits
- [X] T058 [US4] Implement recovery UI notifications: show toast/banner in StatusBar when crash recovery runs, display degraded state warnings, show worker restart notifications per WorkerHealth status transitions

**Checkpoint**: At this point, User Stories 1-4 should all work. The application gracefully handles crashes, verifies data integrity, auto-restarts failed workers, and communicates recovery status to the user.

---

## Phase 7: User Story 5 - Manage Application Tabs (Priority: P3)

**Goal**: An analyst can open new query editor tabs, switch between them, close tabs, and have their tab arrangement persist between sessions including query text and scroll positions.

**Independent Test**: Open 3+ tabs with different SQL text, switch between them, close one, restart the application, confirm remaining tabs restore correctly with their previous SQL text, cursor positions, and scroll offsets.

### Implementation for User Story 5

- [X] T059 [US5] Implement tab creation: new tab action creates Tab record in Dexie.js (query/catalog/settings type), auto-increment order, set active, deactivate other tabs, update last_active_tab_id in app_state per contracts/dexie-schema.md write patterns
- [X] T060 [US5] Implement tab closing: delete Tab record, activate nearest remaining tab, reorder remaining tabs to fill gap, update last_active_tab_id per contracts/dexie-schema.md closeTab pattern
- [X] T061 [US5] Implement tab switching with state preservation: on tab switch update active flag in Dexie.js, save current tab state (SQL text, cursorPosition, scrollTop) before switching, load target tab state
- [X] T062 [US5] Implement debounced tab state persistence: on meaningful user interactions (typing SQL, scrolling, cursor movement) debounce-write tab state to Dexie.js tabs collection (250ms debounce)
- [X] T063 [US5] Implement tab state restoration on app launch: load all tabs from Dexie.js sorted by order, focus tab matching app_state['last_active_tab_id'], restore per-tab state (SQL text, cursor position, scroll offset)
- [X] T064 [US5] Implement window bounds persistence and restoration: save BrowserWindow position and size to app_state['window_bounds'] on move/resize (debounced), restore on launch per data-model.md app_state schema
- [X] T065 [US5] Wire TabBar UI actions: new tab button, close tab button (per tab), tab reordering (drag or click order), keyboard shortcuts (Cmd+T new tab, Cmd+W close tab, Cmd+Shift+[ / ] switch tabs)

**Checkpoint**: All user stories should now be independently functional. Full tab lifecycle with persistence works across normal restarts.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [X] T066 [P] Implement default preference seeding: on first launch, populate Dexie.js preferences collection with Phase 1 defaults (theme:system, fontSize:14, defaultLimit:1000, autoComplete:true, tabSize:2, duckdbLimitPct:50) per data-model.md preferences section
- [X] T067 [P] Implement query history sync: after query execution, write QueryHistoryRecord to both DuckDB _query_history table and Dexie.js query_history collection via CatalogSyncBridge per data-model.md query_history schema
- [X] T068 [P] Implement tmp/ directory cleanup on graceful shutdown: delete contents of ~/Library/Application Support/Datspace/tmp/ during shutdown sequence
- [X] T069 [P] Implement DuckDB extension bundling: bundle parquet, json, icu extensions in resources/duckdb-extensions/ and load from bundled path at Worker startup (httpfs deferred to Phase 3)
- [X] T070 Add global type declaration file for window.datspace in src/renderer/types/datspace.d.ts per contracts/preload-api.md Type Declaration File
- [X] T071 Run quickstart.md verification checklist: confirm all 10 verification items pass (launch <2s, SELECT 42, tab persistence, health monitoring, Arrow IPC confirmed, cancellation, crash recovery, macOS integration, large result streaming, memory budget)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies -- can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion -- BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - US1 (Phase 3) should be completed first as MVP
  - US2 (Phase 4) can follow immediately after US1
  - US3 (Phase 5) and US4 (Phase 6) can start after Foundational, independent of each other
  - US5 (Phase 7) builds on US1's basic tab rendering
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) -- No dependencies on other stories. **This is the MVP.**
- **User Story 2 (P1)**: Can start after Foundational (Phase 2) -- Enhances US1 by adding query editor content to tabs. Best done after US1.
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) -- Independent catalog view. Shares QueryRouter with US2 for IPC handlers.
- **User Story 4 (P2)**: Can start after Foundational (Phase 2) -- Enhances WorkerManager from Foundational with monitoring/restart. Independent of other stories.
- **User Story 5 (P3)**: Can start after Foundational (Phase 2) -- Extends US1's basic TabBar with full CRUD. Benefits from US1 being complete first.

### Within Each User Story

- Shared infrastructure (types, constants) before story-specific modules
- Backend/Worker changes before Renderer components
- IPC handlers before UI components that call them
- Core implementation before integration wiring
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks T005-T011 marked [P] can run in parallel (different config files)
- All Foundational tasks T013-T015, T017-T018, T020 marked [P] can run in parallel (different source files)
- Within US2: T037 (arrow-decode) and T038 (backpressure) can run in parallel
- Within US1: T027 (index.html) and T028 (index.tsx) can run in parallel
- US3 and US4 can be worked on in parallel by different agents (independent stories)

---

## Parallel Example: Phase 2 Foundational

```bash
# Launch all independent foundational modules together:
Task: "Define shared TypeScript types in src/shared/types.ts"
Task: "Define channel names and config defaults in src/shared/constants.ts"
Task: "Define error taxonomy in src/shared/errors.ts"
Task: "Implement DatspaceDB Dexie.js schema in src/renderer/stores/db.ts"
Task: "Define typed DatspaceAPI interface in src/preload/api.ts"
Task: "Implement DuckDB connection manager in src/workers/duckdb-connection.ts"

# Then sequentially (has dependencies on types/constants):
Task: "Implement preload contextBridge in src/preload/index.ts"
Task: "Implement DuckDB Worker Thread entry in src/workers/duckdb-worker.ts"
Task: "Implement WorkerManager in src/main/worker-manager.ts"
Task: "Implement IPC handler registration in src/main/ipc-handlers.ts"
```

## Parallel Example: User Story 2

```bash
# Launch independent decoder modules together:
Task: "Implement Flechette Arrow IPC decoder in src/renderer/lib/arrow-decode.ts"
Task: "Implement backpressure flow control in src/renderer/lib/backpressure.ts"

# Then sequentially (depends on decoder + IPC):
Task: "Implement QueryEditor component in src/renderer/components/QueryEditor.tsx"
Task: "Implement ResultGrid component in src/renderer/components/ResultGrid.tsx"
Task: "Wire query execution end-to-end"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL -- blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Launch app, confirm window appears in <2s, UI shell renders, worker health shows in StatusBar, graceful shutdown works
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational -> Foundation ready
2. Add User Story 1 -> Test independently -> **MVP!** (app shell launches and renders)
3. Add User Story 2 -> Test independently -> **Core value** (SQL queries return results)
4. Add User Story 3 -> Test independently -> **Schema discovery** (browse tables and columns)
5. Add User Story 4 -> Test independently -> **Production resilience** (crash recovery, health monitoring)
6. Add User Story 5 -> Test independently -> **Multi-tab workflow** (full tab management with persistence)
7. Polish phase -> Run verification checklist -> Release candidate

### Parallel Agent Strategy

With multiple agents:

1. All agents collaborate on Setup + Foundational
2. Once Foundational is done:
   - Agent A: User Story 1 (app shell, lifecycle)
   - Agent B: User Story 2 (query pipeline) -- after Agent A completes basic shell
   - Agent C: User Story 3 (catalog browser) -- can start after Foundational
   - Agent D: User Story 4 (crash recovery) -- can start after Foundational
3. User Story 5 after US1 is complete (extends tab management)
4. Polish phase after all desired stories are done

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks within the same phase
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Key constraint: Arrow IPC for all data-plane transfers (Constitution Principle I) -- no JSON serialization in data paths
- Key constraint: DuckDB runs in Worker Thread only (Constitution Principle IV) -- Main Process never touches DuckDB directly
- Key constraint: Renderer has no Node.js access (contextIsolation:true, nodeIntegration:false) -- all system access via preload bridge
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
