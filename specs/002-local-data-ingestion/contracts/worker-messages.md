# Worker Message Contracts: Local Data Ingestion

**Feature**: 002-local-data-ingestion
**Date**: 2026-02-07

All new Worker messages extend the existing `WorkerInboundMessage` / `WorkerOutboundMessage` discriminated unions. Validated by Zod schemas in `src/shared/schemas/worker-schemas.ts` (extended) and `src/shared/schemas/ingestion-schemas.ts` (new).

---

## New Inbound Messages (Main → Worker)

### Message: `ingest_file`

**Purpose**: Parse a local file and register it as a DuckDB table. The Worker creates a `CREATE TABLE AS SELECT * FROM read_*(path)` to materialize the data.

```typescript
interface WorkerIngestFileRequest {
  readonly type: 'ingest_file';
  readonly jobId: string;             // IngestionJob.id for progress tracking
  readonly filePath: string;          // Absolute path to source file
  readonly format: DataSourceFormat;  // Pre-detected format
  readonly tableName: string;         // Target DuckDB table name
  readonly options: IngestFileOptions;
}

interface IngestFileOptions {
  /** CSV/TSV: Override auto-detected delimiter. */
  readonly delimiter?: string;
  /** CSV/TSV: Override encoding detection. Default: 'utf-8'. */
  readonly encoding?: 'utf-8' | 'latin-1';
  /** CSV: Whether first row is a header. Default: auto-detect. */
  readonly header?: boolean;
  /** JSON: Format hint. Default: 'auto'. */
  readonly jsonFormat?: 'auto' | 'array' | 'newline_delimited' | 'unstructured';
  /** XLSX: Sheet name or index. Default: first sheet. */
  readonly sheet?: string | number;
  /** Sample size for type inference. Default: 20480. */
  readonly sampleSize?: number;
  /** Whether to skip invalid rows instead of failing. Default: true. */
  readonly ignoreErrors?: boolean;
}
```

**Response**: `ingest_file_progress` (multiple) → `ingest_file_complete` | `error`

---

### Message: `preview_file`

**Purpose**: Create a DuckDB VIEW over a file for instant schema inspection and data preview without materializing.

```typescript
interface WorkerPreviewFileRequest {
  readonly type: 'preview_file';
  readonly filePath: string;
  readonly format: DataSourceFormat;
  readonly viewName: string;          // Target DuckDB view name (e.g., "preview__abc123")
  readonly options: IngestFileOptions; // Same options as ingest_file
}
```

**Response**: `preview_file_complete` | `error`

```typescript
interface WorkerPreviewFileComplete {
  readonly type: 'preview_file_complete';
  readonly viewName: string;
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
  }[];
  readonly estimatedRowCount: number;  // From DuckDB table statistics (approximate for views)
}
```

---

### Message: `compute_stats`

**Purpose**: Compute column statistics for a materialized table using DuckDB `SUMMARIZE` and custom aggregates.

```typescript
interface WorkerComputeStatsRequest {
  readonly type: 'compute_stats';
  readonly tableName: string;         // DuckDB table name
  readonly columns?: readonly string[]; // Specific columns. If omitted, all columns.
  readonly topN?: number;             // Top-N frequent values for categorical. Default: 10.
}
```

**Response**: `compute_stats_complete` | `error`

```typescript
interface WorkerComputeStatsComplete {
  readonly type: 'compute_stats_complete';
  readonly tableName: string;
  readonly columns: readonly WorkerColumnStats[];
  readonly durationMs: number;
}

interface WorkerColumnStats {
  readonly columnName: string;
  readonly columnType: string;
  readonly rowCount: number;
  readonly nullCount: number;
  readonly nullPercentage: number;
  readonly distinctCount: number;       // approx_count_distinct
  readonly min: string | undefined;     // Serialized as string for uniformity
  readonly max: string | undefined;
  readonly mean: number | undefined;    // Numeric columns only
  readonly median: number | undefined;  // Numeric columns only
  readonly stddev: number | undefined;  // Numeric columns only
  readonly q25: number | undefined;     // Numeric columns only
  readonly q75: number | undefined;     // Numeric columns only
  readonly topValues: readonly {
    readonly value: string;
    readonly count: number;
  }[] | undefined;                     // Categorical columns only
}
```

---

### Message: `drop_table`

**Purpose**: Drop a DuckDB table or view when a data source is removed from the catalog.

```typescript
interface WorkerDropTableRequest {
  readonly type: 'drop_table';
  readonly tableName: string;
  readonly isView: boolean;           // DROP VIEW vs DROP TABLE
}
```

**Response**: `drop_table_complete` | `error`

```typescript
interface WorkerDropTableComplete {
  readonly type: 'drop_table_complete';
  readonly tableName: string;
}
```

---

### Message: `install_extension`

**Purpose**: Install a DuckDB extension (used for `arrow` community extension on first launch).

```typescript
interface WorkerInstallExtensionRequest {
  readonly type: 'install_extension';
  readonly extensionName: string;
  readonly source?: 'core' | 'community';  // Default: 'core'
}
```

**Response**: `install_extension_complete` | `error`

```typescript
interface WorkerInstallExtensionComplete {
  readonly type: 'install_extension_complete';
  readonly extensionName: string;
  readonly loaded: boolean;
}
```

---

### Message: `sniff_csv`

**Purpose**: Run DuckDB's CSV sniffer on a file to detect dialect (delimiter, quote, escape, header) before import.

```typescript
interface WorkerSniffCsvRequest {
  readonly type: 'sniff_csv';
  readonly filePath: string;
}
```

**Response**: `sniff_csv_complete` | `error`

```typescript
interface WorkerSniffCsvComplete {
  readonly type: 'sniff_csv_complete';
  readonly filePath: string;
  readonly delimiter: string;
  readonly quoteChar: string;
  readonly escapeChar: string;
  readonly hasHeader: boolean;
  readonly newlineDelimiter: string;
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
  }[];
  readonly dateFormat: string | undefined;
  readonly timestampFormat: string | undefined;
}
```

---

## New Outbound Messages (Worker → Main)

### Message: `ingest_file_progress`

**Purpose**: Periodic progress updates during file ingestion. Sent after each batch is processed.

```typescript
interface WorkerIngestFileProgress {
  readonly type: 'ingest_file_progress';
  readonly jobId: string;
  readonly rowsProcessed: number;      // Cumulative
  readonly bytesProcessed: number;     // Cumulative Arrow IPC bytes
  readonly batchIndex: number;
  readonly durationMs: number;
}
```

### Message: `ingest_file_complete`

**Purpose**: Notification that file ingestion has finished successfully.

```typescript
interface WorkerIngestFileComplete {
  readonly type: 'ingest_file_complete';
  readonly jobId: string;
  readonly tableName: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
  }[];
  readonly durationMs: number;
  readonly skippedRows: number;        // Rows skipped due to parse errors (ignoreErrors: true)
}
```

---

## Updated Discriminated Union

The `WorkerInboundMessage` union in `src/shared/schemas/worker-schemas.ts` must be extended with:

```typescript
type WorkerInboundMessage =
  | WorkerQueryRequest          // existing
  | WorkerCancelRequest         // existing
  | WorkerGetTableInfoRequest   // existing
  | WorkerHealthCheck           // existing
  | HeartbeatRequest            // existing
  | WorkerConfigUpdate          // existing
  | ShutdownRequest             // existing
  // NEW for 002-local-data-ingestion:
  | WorkerIngestFileRequest
  | WorkerPreviewFileRequest
  | WorkerComputeStatsRequest
  | WorkerDropTableRequest
  | WorkerInstallExtensionRequest
  | WorkerSniffCsvRequest;
```

The `WorkerOutboundMessage` union must be extended with:

```typescript
type WorkerOutboundMessage =
  | WorkerQueryResponse          // existing
  | WorkerGetTableInfoResponse   // existing
  | WorkerHealthCheckResponse    // existing
  | HeartbeatAck                 // existing
  | WorkerReadyMessage           // existing
  | ShutdownComplete             // existing
  | WorkerErrorResponse          // existing
  // NEW for 002-local-data-ingestion:
  | WorkerIngestFileProgress
  | WorkerIngestFileComplete
  | WorkerPreviewFileComplete
  | WorkerComputeStatsComplete
  | WorkerDropTableComplete
  | WorkerInstallExtensionComplete
  | WorkerSniffCsvComplete;
```
