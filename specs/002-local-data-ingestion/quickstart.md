# Quickstart: Local Data Ingestion

**Feature**: 002-local-data-ingestion
**Date**: 2026-02-07

This guide gets developers oriented for implementing Phase 2. It covers the key integration points, required dependencies, and implementation sequence.

---

## Prerequisites

- Phase 1 foundation is complete and operational (branch `001-electron-foundation`)
- Node.js 20.18.0+ (bundled with Electron 33)
- macOS arm64 or x64

---

## 1. Install New Dependencies

```bash
# Production dependencies
npm install @finos/perspective @finos/perspective-viewer @finos/perspective-viewer-datagrid @finos/perspective-react chokidar@4

# No new dev dependencies needed — existing test infrastructure covers Phase 2
```

**Perspective WASM assets**: The Perspective packages include WASM binaries that need to be served by the Vite dev server. Add to `vite.renderer.config.ts`:

```typescript
// Ensure .wasm files are served correctly
optimizeDeps: {
  exclude: ['@finos/perspective'],
},
```

---

## 2. DuckDB Extension Setup

The Worker initialization (`duckdb-connection.ts`) needs to load additional extensions:

```sql
-- Already in default config (auto-loads):
-- parquet, json, icu

-- New extensions needed:
INSTALL excel;     -- Auto-loads on first read_xlsx() call
LOAD excel;

-- Community extension (requires network on first install):
INSTALL arrow FROM community;
LOAD arrow;
```

Update the `extensions` config default in `src/shared/constants.ts`:

```typescript
extensions: ['parquet', 'json', 'icu', 'excel']
// Note: 'arrow' is installed separately (community, not core)
```

---

## 3. Implementation Sequence

The recommended build order based on dependency analysis:

### Layer 0: Shared Foundation (no dependencies)

1. **Zod schemas** — `ingestion-schemas.ts`, `catalog-schemas.ts`
2. **Types** — Extend `types.ts` with ingestion types, status enums
3. **Constants** — Add IPC channels, push events, error codes
4. **Errors** — Add E2xxx ingestion error codes to `errors.ts`

### Layer 1: Worker Messages (depends on Layer 0)

4. **Worker message handlers** — Add `ingest_file`, `preview_file`, `compute_stats`, `drop_table`, `sniff_csv`, `install_extension` to `duckdb-worker.ts`
5. **Extension loading** — Update `duckdb-connection.ts` init sequence
6. **Worker schema extension** — Update `worker-schemas.ts` discriminated union

### Layer 2: Main Process Services (depends on Layer 1)

7. **Format detector** — `format-detector.ts` (extension + magic byte detection)
8. **Ingestion router** — `ingestion-router.ts` (orchestrates file → Worker → catalog)
9. **Progress tracker** — `progress-tracker.ts` (tracks active jobs, relays progress)
10. **File watcher** — `file-watcher.ts` (chokidar service)
11. **IPC handlers** — Extend `ipc-handlers.ts` with ingestion + catalog + watch channels
12. **Lifecycle** — Extend `lifecycle.ts` startup/shutdown with watcher init/teardown

### Layer 3: Preload Bridge (depends on Layer 2)

13. **Preload API** — Add `ingestion`, extended `catalog`, and `watch` namespaces to `api.ts`
14. **Preload index** — Wire new namespaces in `index.ts`

### Layer 4: Renderer (depends on Layer 3)

15. **Dexie schema** — Add `data_sources`, `ingestion_jobs`, `watch_directories`, `column_statistics` tables to `db.ts`
16. **Dexie hooks** — Add `useCatalogSources`, `useIngestionJobs`, `useWatchDirectories`, `useColumnStats` to `hooks.ts`
17. **Perspective DataGrid** — `DataGrid.tsx` component wrapping `<PerspectiveViewer>`
18. **Import dialog** — `ImportDialog.tsx` (file picker + drag-and-drop)
19. **Catalog sidebar** — `CatalogSidebar.tsx` (replaces basic CatalogBrowser)
20. **Ingestion progress** — `IngestionProgress.tsx` (progress bar + cancel)
21. **Column stats** — `ColumnStats.tsx` (per-column statistics panel)
22. **Source detail** — `SourceDetail.tsx` (metadata + status + actions)
23. **Watch config** — `WatchDirConfig.tsx` (watch directory setup)

### Layer 5: Integration (depends on all above)

24. **App wiring** — Connect new components to `App.tsx` and tab system
25. **Integration tests** — End-to-end ingestion pipeline tests
26. **E2E tests** — Playwright tests for file import, grid interaction, folder watch

---

## 4. Key Integration Points

### Where new code plugs into Phase 1:

| Integration Point | Phase 1 File | What Changes |
|-------------------|-------------|--------------|
| Worker message dispatch | `duckdb-worker.ts` | Add cases to `switch (msg.type)` for new message types |
| IPC handler registration | `ipc-handlers.ts` | Add `ipcMain.handle()` for new channels |
| Startup sequence | `lifecycle.ts` | Add watcher init after step 6 (MessagePort setup) |
| Shutdown sequence | `lifecycle.ts` | Add watcher teardown before Worker shutdown |
| Preload bridge | `api.ts` + `index.ts` | Add `ingestion`, `watch` namespaces to `DatspaceAPI` |
| Dexie schema version | `db.ts` | Bump version, add new table stores |
| Renderer tab system | `App.tsx` | Add `DataGridTab` type for imported table views |
| Constants | `constants.ts` | Add IPC channels, push events |
| Types | `types.ts` | Add ingestion types to type unions |

### Data flow for a file import:

```
User drops CSV file                          DuckDB Worker
       │                                          │
       ▼                                          │
  ImportDialog.tsx                                 │
  (validates extension)                            │
       │                                          │
       ▼                                          │
  ipcRenderer.invoke('ingestion:importFiles')      │
       │                                          │
       ▼                                          │
  ipc-handlers.ts                                 │
       │                                          │
       ▼                                          │
  ingestion-router.ts                             │
  (creates IngestionJob, sends worker message)     │
       │                                          │
       ▼                                          ▼
  worker.postMessage({type: 'ingest_file'})  ─►  CREATE TABLE AS
                                                  SELECT * FROM read_csv()
       │                                          │
       ◄──────── ingest_file_progress ◄───────────┘
       │                                          │
       ◄──────── ingest_file_complete ◄───────────┘
       │
       ▼
  ingestion-router.ts
  (updates DataSource status → active)
       │
       ▼
  webContents.send('ingestion:complete')
       │
       ▼
  Renderer updates Dexie.js
  (DataSource, CatalogEntry, ColumnSchema)
       │
       ▼
  CatalogSidebar re-renders via useLiveQuery()
```

---

## 5. Testing Strategy

| Test Layer | Framework | Focus |
|------------|-----------|-------|
| **Schema validation** | Vitest + fast-check | Zod schemas accept valid data, reject invalid |
| **Worker messages** | Vitest (mocked DuckDB) | Message dispatch, error handling, progress reporting |
| **Ingestion router** | Vitest (mocked Worker) | Job lifecycle, status transitions, progress relay |
| **File watcher** | Vitest (mocked chokidar) | Event handling, filtering, stabilization |
| **Format detector** | Vitest | Extension mapping, magic byte detection |
| **Renderer components** | Vitest + @testing-library/react | Component rendering, user interactions |
| **Dexie operations** | Vitest + fake-indexeddb | CRUD operations, reactive queries |
| **Integration** | Vitest | Full ingestion pipeline (real DuckDB, test files) |
| **E2E** | Playwright | File picker, drag-and-drop, grid interaction |

**Test fixtures**: Create small sample files in `tests/fixtures/` for each supported format:
- `sample.csv` (100 rows, mixed types, header)
- `sample.tsv` (tab-delimited variant)
- `sample.parquet` (100 rows, Parquet format)
- `sample.json` (JSON array of 100 records)
- `sample.jsonl` (100 newline-delimited JSON objects)
- `sample.xlsx` (100 rows, single sheet)
- `sample.arrow` (100 rows, Arrow IPC format)
- `malformed.csv` (encoding issues, missing values)
- `headerless.csv` (no header row)
- `large.csv` (1M rows for performance testing — generated, not committed)

---

## 6. Environment Setup for Development

```bash
# 1. Switch to feature branch
git checkout 002-local-data-ingestion

# 2. Install dependencies (including new Perspective + chokidar)
npm install

# 3. Start Vite dev server (required for MCP visual testing)
npx vite --config vite.renderer.config.ts --port 5173

# 4. In another terminal, start the app
npx electron-forge start

# 5. Run tests in watch mode while developing
npm run test:watch

# 6. Type check
npm run typecheck
```
