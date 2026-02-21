# Research: Local Data Ingestion

**Feature**: 002-local-data-ingestion
**Date**: 2026-02-07
**Status**: Complete — all NEEDS CLARIFICATION items resolved

---

## RQ-1: DuckDB File Format Readers

**Decision**: Use DuckDB's native `read_*()` functions for all seven formats.

**Rationale**: DuckDB's built-in readers handle CSV/TSV, Parquet, JSON/JSONL natively with auto-detection, streaming, and type inference. The `excel` and `arrow` extensions complete XLSX and Arrow IPC support. This keeps all parsing in the Worker thread (Constitution Principle IV) and avoids Node.js-side parsing libraries.

**Alternatives considered**:
- **Papa Parse (CSV) + SheetJS (XLSX) + custom JSON parser**: Would require parsing in Node.js, then copying data to DuckDB via INSERT. Violates Constitution Principle III (Stream and Scan) by materializing full datasets in JavaScript memory. Adds 3+ dependencies vs. 0 new dependencies.
- **DuckDB `COPY FROM`**: `COPY` is for importing into persistent tables. `read_*()` functions are more flexible — they can be wrapped in `CREATE VIEW` (lazy) or `CREATE TABLE AS` (materialized) depending on need.

**SQL patterns per format**:

| Format | DuckDB Function | Extension | Auto-detects? |
|--------|----------------|-----------|---------------|
| CSV | `read_csv(path)` | Built-in | Delimiter, header, types, encoding |
| TSV | `read_csv(path, delim='\t')` | Built-in | Header, types |
| Parquet | `read_parquet(path)` | `parquet` (auto-loads) | Schema from metadata |
| JSON | `read_json(path, format='array')` | `json` (auto-loads) | Types from values |
| JSONL | `read_json(path, format='newline_delimited')` | `json` (auto-loads) | Types from values |
| XLSX | `read_xlsx(path)` | `excel` (auto-loads) | Sheet, header, types |
| Arrow IPC | `read_arrow(path)` | `arrow` (community, manual install) | Schema from metadata |

**CSV Sniffer**: DuckDB's multi-hypothesis sniffer tests 24 combinations of (delimiter x quote x escape). Delimiter candidates: `,`, `|`, `;`, `\t`. Samples 20,480 rows by default. Use `sniff_csv(path)` to preview detection results before import.

---

## RQ-2: File Registration Strategy — VIEW vs TABLE

**Decision**: Two-phase registration. Phase 1: `CREATE VIEW` for instant preview. Phase 2: `CREATE TABLE AS` for materialized querying after user confirmation.

**Rationale**: `CREATE VIEW` is instant (no data copy), lets users preview schema and data immediately, and reflects file changes. Once the user confirms import, `CREATE TABLE AS` materializes data into DuckDB's columnar format for fast repeated queries (sort, filter, aggregate).

**Alternatives considered**:
- **VIEW only**: Fast preview but slow repeated queries on large files (re-reads file each time). Unacceptable for sort/filter performance on 1M+ rows (SC-006: < 2s).
- **TABLE only**: Forces full import before any preview. Slow initial experience for large files (SC-001: < 30s for 100 MB).
- **VIEW with progressive TABLE migration**: Considered starting with VIEW and migrating to TABLE in the background. Added complexity with minimal UX benefit vs. explicit two-phase.

**Implementation pattern**:
```sql
-- Phase 1: Instant preview (lazy view)
CREATE VIEW "preview__{source_id}" AS SELECT * FROM read_csv('/path/to/file.csv');

-- Phase 2: Materialized import (fast queries)
CREATE TABLE "{source_name}" AS SELECT * FROM read_csv('/path/to/file.csv');
DROP VIEW "preview__{source_id}";
```

---

## RQ-3: Column Statistics Computation

**Decision**: Use DuckDB `SUMMARIZE` for quick profiling, supplemented by custom aggregate queries for top-N frequent values.

**Rationale**: `SUMMARIZE` provides min, max, avg, stddev, q25/q50/q75, approx_unique, null_percentage in a single pass. Top-N frequent values for categorical columns require a separate `GROUP BY` + `ORDER BY` + `LIMIT` query since `SUMMARIZE` doesn't cover this.

**Alternatives considered**:
- **All custom aggregates**: More control but requires building 10+ aggregate expressions per column. `SUMMARIZE` is a single command.
- **Compute-thread statistics (Worker #3)**: Constitution mentions Worker #3 for "file parsing, Arrow transforms." Statistics computation is a DuckDB query, not a file transform — it belongs in Worker #1 with DuckDB.
- **Client-side computation with Arquero**: Violates Constitution Principle III (never load full datasets into JS memory).

**SQL patterns**:
```sql
-- Quick profile (all columns at once)
SUMMARIZE SELECT * FROM "my_table";
-- Returns: column_name, column_type, min, max, approx_unique, avg, std, q25, q50, q75, count, null_percentage

-- Top-N frequent values for categorical columns
SELECT "{col}" AS value, COUNT(*) AS frequency
FROM "my_table"
WHERE "{col}" IS NOT NULL
GROUP BY "{col}"
ORDER BY frequency DESC
LIMIT 10;
```

---

## RQ-4: Perspective.js Integration with Arrow IPC

**Decision**: Pass Arrow IPC `ArrayBuffer` directly from the data plane to `perspective.worker().table(buffer)`. No flechette decode step needed for the grid.

**Rationale**: Perspective.js has its own C++ Arrow engine compiled to WASM. It consumes Arrow IPC binary format directly — passing through flechette first would be a redundant decode/re-encode cycle. Flechette is still used for metadata extraction (column names, types, row counts) needed by the catalog sidebar and stats panel.

**Alternatives considered**:
- **Flechette decode → Perspective load**: Double-decodes the Arrow IPC. Wasteful.
- **Flechette decode → JSON → Perspective**: Violates Constitution Principle I (Arrow-first data flow). Catastrophically slow for large datasets.
- **Apache Arrow JS → Perspective**: Constitution mandates flechette (~38 KB) over apache-arrow (~163 KB). And Perspective doesn't accept Arrow Table JS objects anyway — it needs raw IPC binary.

**Data flow for grid rendering**:
```
DuckDB Worker                     Renderer
────────────                      ────────
to_arrow_ipc(SQL)
  → BLOB chunks
  → concat Uint8Array
                   MessagePort
                   ──────────→    ArrayBuffer
                                    ├── perspective.table(buffer) → WASM grid
                                    └── flechette.tableFromIPC(buffer) → metadata
```

**Perspective packages needed**:
- `@finos/perspective` — Core WASM engine (~7.3 MB install, WASM loaded lazily)
- `@finos/perspective-viewer` — Web Component UI shell
- `@finos/perspective-viewer-datagrid` — `regular-table` based virtual grid
- `@finos/perspective-react` — React wrapper (`<PerspectiveViewer>`)

**Virtual scrolling**: Perspective renders only visible cells in the DOM (~50-100 rows). Sorting, filtering, and aggregation happen in WASM — only the viewport slice is serialized to JavaScript. Handles 10M+ rows natively.

---

## RQ-5: File Watching Architecture

**Decision**: Run chokidar v4 in the Main process. Use `awaitWriteFinish` for file stabilization. Monitor `/Volumes` at depth 0 for removable drive detection.

**Rationale**: File watching is I/O-bound, not CPU-bound. Main process is the natural home for OS-level integrations (file dialogs, drag-and-drop also originate there). Constitution Principle IV assigns lifecycle/routing to Main. The heavy work (DuckDB parsing) stays in the Worker.

**Alternatives considered**:
- **Chokidar in Worker Thread**: Adds IPC overhead (every file event → Main → Renderer for catalog update). No CPU benefit since watching is event-driven, not compute-intensive.
- **Native `fs.watch()` without chokidar**: Missing features: `awaitWriteFinish`, recursive watching management, `ignored` filtering, `ready` event for initial scan. Constitution explicitly mandates "chokidar."
- **Chokidar v3 (with native fsevents)**: Requires packaging native `.node` binary (ASAR extraction, code signing). Chokidar v4 uses Node.js built-in `fs.watch()` which uses FSEvents via libuv — same kernel mechanism, no native module.
- **Chokidar v5 (ESM-only)**: Requires `"type": "module"` in package.json. Project uses CJS. Chokidar v4 supports both.

**Key configuration**:
```typescript
{
  persistent: true,
  followSymlinks: false,
  awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  ignored: extensionFilterFunction,  // Only SUPPORTED_EXTENSIONS
  ignoreInitial: false,              // Report existing files on first scan
  usePolling: false,                 // Use native FSEvents via fs.watch()
  atomic: true,                      // Handle atomic saves (delete+create)
}
```

**Removable drive strategy**: Watch `/Volumes` at depth 0 for `addDir`/`unlinkDir` events. On `unlinkDir`, pause watchers and mark sources as "unavailable." On `addDir`, resume watchers and offer re-ingestion.

**Lifecycle integration**: Add to `lifecycle.ts` shutdown sequence — close all watchers before Worker shutdown to prevent events firing after Worker is terminated.

---

## RQ-6: Encoding Detection Strategy

**Decision**: Two-pass approach. Try UTF-8 first (DuckDB default). On failure, retry with `encoding = 'latin-1'`. For broader support, install the DuckDB `encodings` extension.

**Rationale**: The spec requires "UTF-8, Latin-1 at minimum" (Assumption). DuckDB assumes UTF-8 by default and provides an explicit `encoding` parameter. A two-pass approach avoids the complexity of pre-detection while covering the vast majority of files.

**Alternatives considered**:
- **Node.js `chardet` pre-detection**: Adds a dependency and a file read pass before DuckDB. Unnecessary since DuckDB reports encoding errors immediately.
- **Always-Latin-1**: Would corrupt UTF-8 multibyte characters (e.g., CJK, emoji).
- **`encodings` extension by default**: Adds install complexity. Defer to later if users request support for Shift-JIS, Big5, etc.

**Implementation pattern**:
```sql
-- Pass 1: Try UTF-8 (default)
SELECT * FROM read_csv('/path/to/file.csv');

-- If error contains "not valid UTF8":
-- Pass 2: Retry with Latin-1
SELECT * FROM read_csv('/path/to/file.csv', encoding = 'latin-1');
```

---

## RQ-7: Ingestion Progress and Cancellation

**Decision**: Track progress via DuckDB query execution time + periodic row count polling. Support cancellation via the existing `cancel_query` Worker message.

**Rationale**: DuckDB's `to_arrow_ipc()` returns rows incrementally. The Worker can report batch progress (batch index, cumulative rows, elapsed time) through the existing data-plane backpressure channel. Cancellation uses the existing `cancel_query` mechanism that clears the active query and stops the result stream.

**Alternatives considered**:
- **DuckDB progress callback**: The Node API doesn't expose a native progress callback for `read_csv()`. Would require polling `duckdb_pending_execution_check_state()` which is not available in `@duckdb/node-api`.
- **File size-based estimation**: Use `fs.stat()` file size + current position for progress percentage. This is unreliable for compressed files (Parquet, gzip CSV) where file position doesn't correlate linearly with rows processed.

**Implementation**: The ingestion job tracks `{ totalBytes (from fs.stat), rowsProcessed (from batch messages), batchesReceived, startTime }`. Progress percentage is estimated as `rowsProcessed / estimatedTotalRows` where `estimatedTotalRows` is derived from the first batch's row count extrapolated to file size.

---

## RQ-8: Drag-and-Drop Implementation

**Decision**: Use Electron's native drag-and-drop events (`dragover`, `drop`) on the Renderer window. Extract file paths from `event.dataTransfer.files`. Send paths to Main via IPC for ingestion.

**Rationale**: Electron supports HTML5 drag-and-drop with file path access (unlike web browsers which only get `File` objects). The Renderer handles the drop zone UI (visual feedback, file type validation), then sends paths to Main for ingestion routing.

**Alternatives considered**:
- **Main process `will-navigate` interception**: Complex and fragile. HTML5 drag-and-drop is the standard Electron pattern.
- **`webContents.on('will-navigate')` + file protocol**: Overly complex for file imports. Standard drag-and-drop is sufficient.

**Drop zone behavior**: Full-window drop zone with visual overlay. Shows supported format list during dragover. Validates file extensions before sending to Main. Supports multiple file drop.

---

## RQ-9: Catalog Status Lifecycle

**Decision**: Four-state lifecycle: `active` → `stale` → `error` → `removed`. Transitions triggered by file watching events and ingestion outcomes.

**Rationale**: Maps directly to the spec's FR-010 (status tracking) and User Story 4 (folder watching). Each state has clear entry conditions and user actions.

**State machine**:
```
                ┌──────────────────────────┐
                │                          │
  import_success│   file_modified          │  file_deleted
       ┌────────▼──┐     ┌────────┐     ┌─▼───────┐
       │  ACTIVE   │────►│ STALE  │     │ REMOVED │
       └────┬──────┘     └───┬────┘     └─────────┘
            │                │                ▲
            │  import_fail   │  re-ingest     │ user_remove
            │    ┌───────┐   │                │
            └───►│ ERROR │◄──┘                │
                 └───┬───┘                    │
                     │  retry_success         │
                     └────────► ACTIVE ───────┘
```

---

## RQ-10: DuckDB Arrow Extension Installation

**Decision**: Install the `arrow` community extension during first launch (in the DuckDB Worker initialization). Gate Arrow IPC file import on extension availability.

**Rationale**: The `arrow` extension is the only community extension needed. It's small and downloads quickly. Auto-installing during Worker init keeps the installation invisible to the user. If network is unavailable, Arrow IPC file import is disabled (other formats still work).

**Alternatives considered**:
- **Bundle the extension binary**: Requires building platform-specific extension binaries into the Electron app. Adds packaging complexity and may break on DuckDB version updates.
- **Require user to install manually**: Poor UX. Users shouldn't need to know about DuckDB extensions.
- **Skip Arrow IPC file support**: Arrow IPC files are the least common user format. However, it's a supported format in the spec (FR-001) and uses the same Arrow IPC pipeline that powers the data plane.

**Implementation**:
```sql
-- During Worker initialization (duckdb-connection.ts)
INSTALL arrow FROM community;
LOAD arrow;
-- If INSTALL fails (no network), log warning and continue without Arrow file support
```
