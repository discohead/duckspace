# Implementation Plan: Local Data Ingestion

**Branch**: `002-local-data-ingestion` | **Date**: 2026-02-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-local-data-ingestion/spec.md`

## Summary

Enable local file ingestion (CSV, TSV, Parquet, JSON, JSONL, XLSX, Arrow IPC), metadata catalog management, and interactive data grid visualization. Files are imported via file picker, drag-and-drop, or folder watching. DuckDB's native readers (`read_csv`, `read_parquet`, `read_json`, `read_xlsx`, `read_arrow`) parse files in the Worker thread. Data flows to the Renderer as Arrow IPC buffers via the existing MessagePort data plane. Perspective.js (WASM + WebGL) provides the virtual-scrolling data grid, consuming Arrow IPC directly. Column statistics are computed via DuckDB `SUMMARIZE` and custom aggregate queries. Chokidar monitors watched directories in the Main process, routing file events to the ingestion pipeline.

## Technical Context

**Language/Version**: TypeScript 5.4, Node.js 20.18.0 (Electron 33), React 18.3
**Primary Dependencies**: `@duckdb/node-api` v1.4.4 (OLAP + file parsing), `@finos/perspective` + `@finos/perspective-viewer` + `@finos/perspective-viewer-datagrid` + `@finos/perspective-react` (data grid), `chokidar` v4 (file watching), `@uwdata/flechette` v2.3.0 (Arrow IPC decode for metadata), `dexie` v4.3.0 (catalog state), `zod` v4.3.6 (schema validation)
**Storage**: DuckDB (Worker Thread #1 — file parsing + analytics), Dexie.js/IndexedDB (Renderer — catalog metadata, ingestion jobs, watch configs)
**Testing**: Vitest (unit/integration), Playwright (e2e), fast-check (property-based), Stryker (mutation)
**Target Platform**: macOS arm64/x64, Electron 33
**Project Type**: Electron desktop (3-process: Main + Renderer + Worker)
**Performance Goals**: 100 MB CSV import < 30s (SC-001), 10M-row grid at 60fps (SC-002), column stats for 1M rows < 5s (SC-003), sort/filter 1M rows < 2s (SC-006)
**Constraints**: DuckDB memory ≤ 50% RAM, Arrow cache ≤ 256 MB LRU, backpressure window 4 batches (~8 MB in-flight), app startup < 2s, UI must never freeze during import/stats
**Scale/Scope**: Single user, local files 1 KB–10 GB, typical 1–50 data sources, 5 user stories, 18 functional requirements

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Assessment |
|-----------|--------|------------|
| **I. Arrow-First Data Flow** | PASS | All data-plane transfers (DuckDB → Renderer) use Arrow IPC via MessagePort. Perspective.js consumes Arrow IPC `ArrayBuffer` directly — no JSON serialization in data hot paths. Flechette decodes Arrow IPC for metadata extraction only. |
| **II. Embedded-Only Databases** | PASS | DuckDB runs in Worker Thread #1 via N-API addon. Dexie.js runs in Renderer for catalog metadata. No external database servers. |
| **III. Stream and Scan** | PASS | DuckDB `read_csv`/`read_parquet`/etc. stream data through the vectorized engine without full materialization. `to_arrow_ipc()` produces chunked RecordBatch output. Perspective WASM engine handles sort/filter/aggregate — only viewport rows are serialized to JS. Backpressure via ACK window (size 4, ~8 MB max). |
| **IV. Process Isolation** | PASS | Main Process: lifecycle, IPC routing, file watching (chokidar), ingestion routing. Worker Thread #1: DuckDB file parsing + query execution. Renderer: Perspective data grid, Dexie.js catalog state. Main does NOT relay data-plane buffers after MessagePort setup. Note: Constitution assigns "File parsing" to Worker #3 (Compute), but Phase 2 uses DuckDB's native readers (`read_csv`, `read_parquet`, etc.) in Worker #1 — these are database operations, not standalone file parsing. Worker #3 is reserved for non-DuckDB transforms (e.g., data export) in later phases. |
| **V. macOS-First** | PASS | Chokidar uses FSEvents via Node.js `fs.watch()` on macOS. Electron native file dialogs for file picker. No cross-platform concerns. |
| **VI. Single-User, Local-First** | PASS | All operations are local filesystem reads. No network access, no authentication. Offline by design. |

**Gate Result: PASS** — All six principles satisfied. No violations requiring justification.

### Technology Stack Verification

| New Dependency | Constitution Mandate | Status |
|----------------|---------------------|--------|
| `@finos/perspective` + datagrid | ADR-003: "Perspective.js (WASM + WebGL)" | Mandated |
| `@finos/perspective-react` | React wrapper for mandated Perspective.js | Required integration |
| `chokidar` v4 | Constitution V: "FSEvents (via chokidar)" | Mandated |
| DuckDB `excel` extension | FR-001: XLSX support | Required — auto-loads |
| DuckDB `arrow` extension | FR-001: Arrow IPC file support | Required — community install |

### DuckDB Extension Requirements

| Extension | Type | Auto-loads? | Needed For |
|-----------|------|-------------|------------|
| `parquet` | Core (primary) | Yes | Parquet files |
| `json` | Core (primary) | Yes | JSON/JSONL files |
| `excel` | Core (secondary) | Yes | XLSX files |
| `arrow` | Community | No — requires `INSTALL arrow FROM community` | Arrow IPC files |
| `icu` | Core | Already configured | Unicode collation |

## Project Structure

### Documentation (this feature)

```text
specs/002-local-data-ingestion/
├── plan.md              # This file
├── research.md          # Phase 0 output — technology decisions
├── data-model.md        # Phase 1 output — entity definitions
├── quickstart.md        # Phase 1 output — developer onboarding
├── contracts/           # Phase 1 output — IPC/message contracts
│   ├── ipc-channels.md          # New IPC channels
│   ├── worker-messages.md       # New worker message types
│   └── data-plane-messages.md   # New data-plane message types
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── main/
│   ├── ingestion/               # NEW — ingestion pipeline
│   │   ├── ingestion-router.ts  # Orchestrates file → DuckDB → catalog
│   │   ├── file-watcher.ts      # Chokidar directory watching service
│   │   ├── format-detector.ts   # File format detection (extension + magic bytes)
│   │   └── progress-tracker.ts  # Per-job progress tracking + cancellation
│   ├── ipc-handlers.ts          # MODIFY — add ingestion + catalog IPC channels
│   ├── lifecycle.ts             # MODIFY — add watcher init/teardown steps
│   ├── query-router.ts          # MODIFY — add SUMMARIZE + stats queries
│   # catalog-sync.ts removed — status lifecycle handled in ingestion-router.ts and ipc-handlers.ts
├── workers/
│   ├── duckdb-worker.ts         # MODIFY — add ingest_file, compute_stats messages
│   ├── duckdb-connection.ts     # MODIFY — extension loading (excel, arrow)
│   └── arrow-stream.ts          # EXISTING — unchanged
├── renderer/
│   ├── components/
│   │   ├── DataGrid.tsx         # NEW — Perspective.js data grid wrapper
│   │   ├── CatalogSidebar.tsx   # NEW — replaces CatalogBrowser for richer catalog
│   │   ├── ColumnStats.tsx      # NEW — per-column statistics panel
│   │   ├── ImportDialog.tsx     # NEW — file picker + drag-and-drop import UI
│   │   ├── WatchDirConfig.tsx   # NEW — watch directory configuration panel
│   │   ├── IngestionProgress.tsx # NEW — progress bar + cancellation for imports
│   │   └── SourceDetail.tsx     # NEW — source metadata + status + actions
│   ├── stores/
│   │   ├── db.ts                # MODIFY — add ingestion_jobs, watch_directories tables
│   │   └── hooks.ts             # MODIFY — add useCatalogSources, useIngestionJobs, etc.
│   └── lib/
│       └── arrow-decode.ts      # EXISTING — may add Perspective integration helpers
├── shared/
│   ├── types.ts                 # MODIFY — add ingestion types, catalog status types
│   ├── constants.ts             # MODIFY — add ingestion IPC channels, status enums
│   ├── errors.ts                # MODIFY — add E2xxx ingestion error codes
│   └── schemas/
│       ├── ingestion-schemas.ts # NEW — Zod schemas for ingestion messages
│       └── catalog-schemas.ts   # NEW — Zod schemas for catalog operations
├── preload/
│   ├── api.ts                   # MODIFY — add ingestion + catalog namespaces
│   └── index.ts                 # MODIFY — wire new namespaces

tests/
├── unit/
│   ├── main/
│   │   ├── ingestion-router.test.ts    # NEW
│   │   ├── file-watcher.test.ts        # NEW
│   │   └── format-detector.test.ts     # NEW
│   ├── workers/
│   │   └── ingest-messages.test.ts     # NEW
│   ├── renderer/
│   │   ├── DataGrid.test.tsx           # NEW
│   │   ├── CatalogSidebar.test.tsx     # NEW
│   │   └── ImportDialog.test.tsx       # NEW
│   └── shared/
│       ├── ingestion-schemas.test.ts   # NEW
│       └── catalog-schemas.test.ts     # NEW
├── integration/
│   └── ingestion-pipeline.test.ts      # NEW — end-to-end ingestion flow
└── e2e/
    ├── file-import.spec.ts             # NEW — file picker + drag-and-drop
    ├── data-grid.spec.ts               # NEW — grid interaction
    └── folder-watch.spec.ts            # NEW — watch directory flow
```

**Structure Decision**: Extends the existing 3-process Electron architecture. New code is organized by concern: `src/main/ingestion/` for the ingestion pipeline (Main process), new Renderer components for UI, and extended Worker messages for DuckDB file operations. Follows existing patterns: discriminated unions for messages, Zod schemas for validation, Dexie.js for Renderer state.

## Complexity Tracking

> No constitution violations — table left intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
