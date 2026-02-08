# Data Model: Local Data Ingestion

**Feature**: 002-local-data-ingestion
**Date**: 2026-02-07

---

## Entity Overview

```
┌──────────────┐     1:N     ┌───────────────┐     1:N     ┌──────────────────┐
│  DataSource  │────────────►│ ColumnSchema   │────────────►│ ColumnStatistics │
└──────┬───────┘             └───────────────┘             └──────────────────┘
       │ 1:N
       ▼
┌──────────────┐
│IngestionJob  │
└──────────────┘

┌────────────────┐     1:N     ┌──────────────┐
│ WatchDirectory │────────────►│  DataSource   │
└────────────────┘             └──────────────┘
```

---

## Entity: DataSource

**Storage**: Dexie.js `data_sources` table (Renderer IndexedDB)
**Purpose**: Represents a registered data file with its metadata. The primary unit of organization in the catalog.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | UUID v4. Primary key. |
| `name` | `string` | Yes | Display name (defaults to filename without extension). User-renamable. |
| `filePath` | `string` | Yes | Absolute path to the source file on disk. |
| `format` | `DataSourceFormat` | Yes | Detected file format (see enum below). |
| `status` | `DataSourceStatus` | Yes | Lifecycle status (see state machine in research.md RQ-9). |
| `duckdbTableName` | `string \| undefined` | No | Name of the materialized DuckDB table (set after import). |
| `duckdbViewName` | `string \| undefined` | No | Name of the preview DuckDB view (set during preview). |
| `rowCount` | `number \| undefined` | No | Total rows after import. |
| `columnCount` | `number \| undefined` | No | Number of columns. |
| `fileSizeBytes` | `number \| undefined` | No | File size at time of import. |
| `fileModifiedAt` | `string \| undefined` | No | ISO 8601 timestamp of file's last modification at import time. |
| `watchDirectoryId` | `string \| undefined` | No | FK to WatchDirectory if auto-discovered. |
| `tags` | `readonly string[]` | Yes | User-assigned tags for filtering. Defaults to `[]`. |
| `errorMessage` | `string \| undefined` | No | Error description when status is `error`. |
| `errorCode` | `string \| undefined` | No | Error code (E2xxx) when status is `error`. |
| `sheetName` | `string \| undefined` | No | XLSX: name of the imported sheet (defaults to first sheet). |
| `createdAt` | `string` | Yes | ISO 8601 timestamp. |
| `updatedAt` | `string` | Yes | ISO 8601 timestamp. |

**Indexes**: `id` (primary), `name`, `status`, `format`, `filePath` (unique), `watchDirectoryId`, `*tags` (multi-entry)

### Enum: DataSourceFormat

```typescript
type DataSourceFormat = 'csv' | 'tsv' | 'parquet' | 'json' | 'jsonl' | 'xlsx' | 'arrow_ipc';
```

### Enum: DataSourceStatus

```typescript
type DataSourceStatus = 'importing' | 'active' | 'stale' | 'error' | 'removed';
```

**State transitions**:

| From | To | Trigger |
|------|----|---------|
| (new) | `importing` | Import initiated (file picker, drag-and-drop, or watch) |
| `importing` | `active` | Import completed successfully |
| `importing` | `error` | Import failed (parse error, unsupported format, disk error) |
| `active` | `stale` | File watcher detects file modification |
| `active` | `removed` | File watcher detects file deletion |
| `active` | `importing` | User triggers re-import |
| `stale` | `importing` | User triggers re-ingest or auto-reingest (watch setting) |
| `stale` | `removed` | File watcher detects file deletion |
| `error` | `importing` | User triggers retry |
| `removed` | (deleted) | User confirms removal from catalog |
| any | (deleted) | User removes source from catalog |

---

## Entity: ColumnSchema

**Storage**: Dexie.js `column_schemas` table (Renderer IndexedDB) — **existing table, extended**
**Purpose**: Per-column schema information for an imported data source.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Composite key: `{dataSourceId}__{columnName}`. |
| `dataSourceId` | `string` | Yes | FK to DataSource. |
| `columnName` | `string` | Yes | Column name as detected by DuckDB. |
| `columnIndex` | `number` | Yes | 0-based ordinal position in the table. |
| `dataType` | `string` | Yes | DuckDB type name (VARCHAR, INTEGER, DOUBLE, TIMESTAMP, etc.). |
| `nullable` | `boolean` | Yes | Whether the column contains NULL values. |
| `isNumeric` | `boolean` | Yes | Derived: type is INTEGER, BIGINT, DOUBLE, FLOAT, DECIMAL, etc. |
| `isCategorical` | `boolean` | Yes | Derived: type is VARCHAR/ENUM with `distinctCount < 100`. |

**Indexes**: `id` (primary), `dataSourceId`

---

## Entity: ColumnStatistics

**Storage**: Dexie.js `column_statistics` table (Renderer IndexedDB) — **new table**
**Purpose**: Per-column statistical summaries computed by DuckDB `SUMMARIZE` and custom aggregates.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Composite key: `{dataSourceId}__{columnName}`. |
| `dataSourceId` | `string` | Yes | FK to DataSource. |
| `columnName` | `string` | Yes | Column name. |
| `rowCount` | `number` | Yes | Total rows in the table. |
| `nullCount` | `number` | Yes | Number of NULL values. |
| `nullPercentage` | `number` | Yes | `nullCount / rowCount * 100`. |
| `distinctCount` | `number` | Yes | Approximate distinct values (HyperLogLog). |
| `min` | `string \| undefined` | No | Minimum value (as string for universal display). |
| `max` | `string \| undefined` | No | Maximum value (as string). |
| `mean` | `number \| undefined` | No | Arithmetic mean (numeric columns only). |
| `median` | `number \| undefined` | No | Median / q50 (numeric columns only). |
| `stddev` | `number \| undefined` | No | Sample standard deviation (numeric columns only). |
| `q25` | `number \| undefined` | No | 25th percentile (numeric columns only). |
| `q75` | `number \| undefined` | No | 75th percentile (numeric columns only). |
| `topValues` | `readonly TopValue[] \| undefined` | No | Top-N frequent values (categorical columns only). |
| `computedAt` | `string` | Yes | ISO 8601 timestamp when stats were computed. |

### Sub-type: TopValue

```typescript
interface TopValue {
  readonly value: string;
  readonly count: number;
  readonly percentage: number;
}
```

**Indexes**: `id` (primary), `dataSourceId`

**Computation note**: The Worker returns `{value, count}` only (see `WorkerColumnStats.topValues` in worker-messages.md). The `percentage` field is computed by the Main process or Renderer as `count / rowCount * 100` before storing in Dexie.

---

## Entity: IngestionJob

**Storage**: Dexie.js `ingestion_jobs` table (Renderer IndexedDB) — **new table**
**Purpose**: Tracks a single file import operation with progress, cancellation support, and error reporting.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | UUID v4. Primary key. |
| `dataSourceId` | `string` | Yes | FK to DataSource. |
| `status` | `IngestionJobStatus` | Yes | Job lifecycle status. |
| `filePath` | `string` | Yes | Absolute path being imported. |
| `format` | `DataSourceFormat` | Yes | Detected format. |
| `fileSizeBytes` | `number \| undefined` | No | Source file size for progress estimation. |
| `rowsProcessed` | `number` | Yes | Cumulative rows imported so far. Defaults to `0`. |
| `batchesReceived` | `number` | Yes | Arrow IPC batches received. Defaults to `0`. |
| `bytesProcessed` | `number` | Yes | Cumulative bytes of Arrow IPC data received. Defaults to `0`. |
| `estimatedTotalRows` | `number \| undefined` | No | Estimated total rows (extrapolated from first batch). |
| `errorMessage` | `string \| undefined` | No | Error detail on failure. |
| `errorCode` | `string \| undefined` | No | Error code (E2xxx) on failure. |
| `startedAt` | `string` | Yes | ISO 8601 timestamp. |
| `completedAt` | `string \| undefined` | No | ISO 8601 timestamp. |
| `durationMs` | `number \| undefined` | No | Total elapsed time. |
| `triggeredBy` | `IngestionTrigger` | Yes | How the import was initiated. |

**Indexes**: `id` (primary), `dataSourceId`, `status`

### Enum: IngestionJobStatus

```typescript
type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
```

### Enum: IngestionTrigger

```typescript
type IngestionTrigger = 'file_picker' | 'drag_and_drop' | 'watch_directory' | 'retry';
```

---

## Entity: WatchDirectory

**Storage**: Dexie.js `watch_directories` table (Renderer IndexedDB) — **new table**
**Purpose**: A configured folder path with settings for automatic file discovery and ingestion.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | UUID v4. Primary key. |
| `path` | `string` | Yes | Absolute directory path. Must exist and be readable. |
| `displayName` | `string` | Yes | User-friendly label (defaults to directory basename). |
| `isActive` | `boolean` | Yes | Whether the watcher is currently running. |
| `recursive` | `boolean` | Yes | Watch subdirectories. Defaults to `true`. |
| `fileTypeFilter` | `readonly DataSourceFormat[]` | Yes | Only ingest these formats. Defaults to all supported formats. |
| `excludePatterns` | `readonly string[]` | Yes | Glob patterns to exclude (e.g., `**/temp_*`). Defaults to `[]`. |
| `autoReingest` | `boolean` | Yes | Automatically re-ingest modified files. Defaults to `false`. |
| `stabilityThresholdMs` | `number` | Yes | How long a file must be unchanged before ingestion (ms). Defaults to `2000`. |
| `sourceCount` | `number` | Yes | Number of data sources discovered from this directory. Defaults to `0`. |
| `lastScanAt` | `string \| undefined` | No | ISO 8601 timestamp of last completed scan. |
| `createdAt` | `string` | Yes | ISO 8601 timestamp. |
| `updatedAt` | `string` | Yes | ISO 8601 timestamp. |

**Indexes**: `id` (primary), `path` (unique), `isActive`

---

## Dexie.js Schema Changes

### New Tables (add to `db.ts` version bump)

```typescript
// Version N+1 schema additions:
ingestion_jobs:   'id, dataSourceId, status'
watch_directories: 'id, &path, isActive'
column_statistics: 'id, dataSourceId'
data_sources:     'id, &filePath, name, status, format, watchDirectoryId, *tags'
```

### Existing Table Modifications

**`catalog_entries`**: The existing `catalog_entries` table tracks DuckDB table/view metadata (name, type, row count). This continues to hold DuckDB-level catalog info. The new `data_sources` table holds ingestion-level metadata (file path, format, status, tags). They are linked by `DataSource.duckdbTableName` → `CatalogEntry.name`.

**`column_schemas`**: Add `dataSourceId` field alongside existing `catalogEntryId` for data-source-centric column lookup. Existing schema query results (from `describeTable`) continue to populate via `catalogEntryId`.

---

## Validation Rules

### DataSource

- `name`: Non-empty string, max 255 chars. No path separators (`/`, `\`).
- `filePath`: Absolute path (starts with `/`). File must exist at import time.
- `format`: Must be one of the `DataSourceFormat` enum values.
- `tags`: Each tag is a non-empty string, max 50 chars. Max 20 tags per source.

### WatchDirectory

- `path`: Absolute path. Directory must exist and be readable.
- `fileTypeFilter`: Non-empty array of valid `DataSourceFormat` values.
- `stabilityThresholdMs`: Range 500–30,000 ms.

### IngestionJob

- `fileSizeBytes`: Non-negative integer.
- `rowsProcessed`, `batchesReceived`, `bytesProcessed`: Non-negative integers.

---

## Zod Schema Locations

| Schema | File |
|--------|------|
| `DataSourceSchema` | `src/shared/schemas/catalog-schemas.ts` |
| `ColumnStatisticsSchema` | `src/shared/schemas/catalog-schemas.ts` |
| `IngestionJobSchema` | `src/shared/schemas/ingestion-schemas.ts` |
| `WatchDirectorySchema` | `src/shared/schemas/ingestion-schemas.ts` |
| `IngestFileRequestSchema` | `src/shared/schemas/ingestion-schemas.ts` |
| `ComputeStatsRequestSchema` | `src/shared/schemas/ingestion-schemas.ts` |
