/**
 * Shared type definitions for the duckspace Electron application.
 *
 * This is the central types file imported by all processes:
 *   - Main Process (src/main/)
 *   - Preload Script (src/preload/)
 *   - Renderer Process (src/renderer/)
 *   - Worker Threads (src/workers/)
 *
 * Organized by domain:
 *   1. IPC Control Plane Messages
 *   2. Data Plane Messages (MessagePort)
 *   3. Worker Control Messages (Main \<-\> DuckDB Worker)
 *   4. Entity Types (Dexie.js collections)
 *   5. API Types (Preload bridge surface)
 *   6. Configuration
 */

// ============================================================
// 1. IPC Control Plane Messages
// ============================================================

/** Request payload for `query:execute` IPC channel */
export interface QueryExecuteRequest {
  /** SQL string with $1, $2, ... parameter placeholders */
  sql: string;
  /** Parameter values for binding (positional) */
  params?: unknown[] | undefined;
}

/** Response payload for `query:execute` IPC channel */
export interface QueryExecuteResponse {
  /** UUID assigned by the QueryRouter for tracking this execution */
  queryId: string;
}

/** Handle returned when a query is submitted for execution (alias for QueryExecuteResponse) */
export interface QueryHandle {
  /** UUID for tracking this query execution */
  queryId: string;
}

/** Extended query handle returned by preview queries, surfacing any limit clamping. */
export interface PreviewHandle extends QueryHandle {
  /** The row limit actually applied to the query. */
  effectiveLimit: number;
  /** True when the requested limit exceeded the safe maximum and was clamped. */
  wasClamped: boolean;
}

/** Request payload for `query:cancel` IPC channel */
export interface QueryCancelRequest {
  /** The queryId returned by query:execute */
  queryId: string;
}

/** Alias for QueryStatusEvent for preload API compatibility */
export type QueryStatus = QueryStatusEvent;

/** Status update pushed during query execution via `query:progress` event */
export interface QueryStatusEvent {
  /** Correlates with the queryId from query:execute */
  queryId: string;
  /** Current execution phase */
  phase: 'scanning' | 'filtering' | 'aggregating' | 'sorting' | 'streaming';
  /** Rows scanned so far (if available from DuckDB progress bar) */
  rowsScanned?: number | undefined;
  /** Rows after filter application */
  rowsFiltered?: number | undefined;
  /** Number of Arrow batches streamed to Renderer */
  batchesStreamed: number;
  /** Estimated total batches (null if unknown) */
  estimatedTotalBatches?: number | undefined;
  /** Milliseconds since query started */
  elapsedMs: number;
}

/** Response payload for `query:listTables` IPC channel */
export interface CatalogListResponse {
  entries: CatalogEntry[];
}

/** Request payload for `query:describeTable` IPC channel */
export interface CatalogDescribeRequest {
  /** DuckDB table or view name */
  tableName: string;
}

/** Response payload for `query:describeTable` IPC channel */
export interface CatalogDescribeResponse {
  /** Table name */
  tableName: string;
  /** DuckDB schema */
  schemaName: string;
  /** Column definitions */
  columns: ColumnSchema[];
  /** Estimated row count */
  rowCount: number;
  /** Estimated storage size */
  sizeBytes: number;
}

/** Request payload for `catalog:preview` IPC channel */
export interface CatalogPreviewRequest {
  /** DuckDB table or view name */
  tableName: string;
  /** Number of sample rows (default: 100,000) */
  limit?: number | undefined;
}

/** Response payload for `catalog:preview` IPC channel */
export interface CatalogPreviewResponse {
  /** Query ID for receiving data on the MessagePort */
  queryId: string;
  /** The row limit actually applied to the query. */
  effectiveLimit: number;
  /** True when the requested limit exceeded the safe maximum and was clamped. */
  wasClamped: boolean;
}

// ============================================================
// 2. Data Plane Messages (MessagePort)
// ============================================================

/** Arrow IPC batch sent from DuckDB Worker to Renderer via MessagePort */
export interface ArrowBatchMessage {
  type: 'arrow-batch';
  /** Correlates with QueryExecuteResponse.queryId */
  queryId: string;
  /** 0-based batch sequence number */
  index: number;
  /** Total batch count (if known; null for streaming) */
  totalBatches?: number | undefined;
  /** Number of rows in this batch */
  rowCount: number;
  /** Size of the Arrow IPC buffer in bytes */
  byteSize: number;
}

/** Stream completion signal from DuckDB Worker to Renderer */
export interface StreamEndMessage {
  type: 'arrow-end';
  /** Correlates with the original queryId */
  queryId: string;
  /** Final count of batches sent */
  totalBatches: number;
  /** Total rows across all batches */
  totalRows: number;
  /** Total bytes transferred */
  totalBytes: number;
  /** Query + transfer duration in milliseconds */
  durationMs: number;
  /** Human-readable status for non-result statements (DDL/DML success) */
  statusMessage?: string | undefined;
}

/** Error delivered on the data plane from DuckDB Worker to Renderer */
export interface DataPlaneError {
  type: 'arrow-error';
  /** Correlates with the original queryId */
  queryId: string;
  /** Error code from taxonomy (E1xxx-E9xxx) */
  code: string;
  /** Human-readable error description */
  message: string;
  /** Number of batches already sent before error */
  batchesSent: number;
}

/** Backpressure acknowledgment from Renderer to DuckDB Worker */
export interface BatchAckMessage {
  type: 'ack';
  /** Correlates with ArrowBatchMessage.queryId */
  queryId: string;
  /** Batch index being acknowledged */
  index: number;
}

/** Cancellation request from Renderer to DuckDB Worker via data plane */
export interface DataPlaneCancelMessage {
  type: 'cancel';
  /** The queryId to cancel */
  queryId: string;
  /** Cancellation reason */
  reason?: 'user_cancelled' | 'component_unmounted' | 'timeout' | 'superseded' | undefined;
}

/** Union of all data plane message types flowing over the duckdb-data MessagePort */
export type DataPlaneMessage =
  | ArrowBatchMessage
  | StreamEndMessage
  | DataPlaneError
  | BatchAckMessage
  | DataPlaneCancelMessage;

// ============================================================
// 3. Worker Control Messages (Main \<-\> DuckDB Worker)
// ============================================================

/** Main -\> DuckDB Worker: Execute SQL query */
export interface WorkerQueryRequest {
  type: 'execute_query';
  /** UUID assigned by QueryRouter */
  queryId: string;
  /** Parameterized SQL with $1, $2, ... placeholders */
  sql: string;
  /** Parameter values for binding */
  params?: unknown[] | undefined;
  /** Execution options */
  options?:
    | {
        /** Query timeout in milliseconds (default: 30000) */
        timeout?: number | undefined;
        /** Override default batch size */
        batchSize?: number | undefined;
        /** Whether this is a read-only query (default: true) */
        readOnly?: boolean | undefined;
      }
    | undefined;
}

/** Main -\> DuckDB Worker: Cancel a running query */
export interface WorkerCancelRequest {
  type: 'cancel_query';
  queryId: string;
}

/** Main -\> DuckDB Worker: Get table information */
export interface WorkerGetTableInfoRequest {
  type: 'get_table_info';
  tableName: string;
}

/** DuckDB Worker -\> Main: Table info response */
export interface WorkerGetTableInfoResponse {
  type: 'table_info';
  tableName: string;
  columns: ColumnSchema[];
  rowCount: number;
  sizeBytes: number;
}

/** DuckDB Worker -\> Main: Catalog update after table registration */
export interface WorkerCatalogUpdate {
  type: 'catalog_update';
  table: string;
  columns: ColumnSchema[];
  rowCount: number;
  sizeBytes: number;
  sourceId: string;
  registrationType: 'table' | 'view';
}

/** Worker -\> Main: Initialization complete */
export interface WorkerReadyMessage {
  type: 'ready';
  worker: 'duckdb';
  metadata?:
    | {
        duckdbVersion?: string | undefined;
        extensionsLoaded?: string[] | undefined;
        tableCount?: number | undefined;
        integrityOk?: boolean | undefined;
      }
    | undefined;
}

/** Main -\> Worker: Request graceful shutdown */
export interface ShutdownRequest {
  type: 'shutdown';
}

/** Worker -\> Main: Shutdown complete */
export interface ShutdownComplete {
  type: 'shutdown-complete';
  worker: 'duckdb';
}

/** Main -\> DuckDB Worker: Update runtime configuration */
export interface WorkerConfigUpdate {
  type: 'configure';
  settings: {
    memory_limit?: string | undefined;
    threads?: number | undefined;
    temp_directory?: string | undefined;
  };
}

/** Main -\> DuckDB Worker: Health check */
export interface WorkerHealthCheck {
  type: 'health_check';
}

/** DuckDB Worker -\> Main: Health check response */
export interface WorkerHealthResponse {
  type: 'health_check_result';
  status: 'healthy' | 'degraded' | 'failed';
  tables: number;
  memoryUsedMB: number;
  activeQueries: number;
}

/** Main -\> DuckDB Worker: Heartbeat ping */
export interface HeartbeatRequest {
  type: 'heartbeat';
  /** Monotonic timestamp for latency measurement */
  sentAt: number;
}

/** DuckDB Worker -\> Main: Heartbeat response */
export interface HeartbeatAck {
  type: 'heartbeat_ack';
  /** Echo back the sentAt timestamp */
  sentAt: number;
  /** Worker's self-reported health */
  status: 'healthy' | 'degraded' | 'busy';
  /** Optional diagnostics */
  details?:
    | {
        activeQueries?: number | undefined;
        memoryUsageMB?: number | undefined;
        uptime?: number | undefined;
      }
    | undefined;
}

/**
 * Union of all worker control messages flowing over parentPort.
 * Derived from Zod schemas to stay in sync (see worker-schemas.ts).
 */
import type { WorkerInboundMessage, WorkerOutboundMessage } from '@shared/schemas/worker-schemas';

export type { WorkerInboundMessage, WorkerOutboundMessage };

/** Union of all worker control messages flowing over parentPort. */
export type WorkerMessage = WorkerInboundMessage | WorkerOutboundMessage;

// ============================================================
// 3a. Ingestion Enums & Options
// ============================================================

/** Supported file formats for local data ingestion */
export type DataSourceFormat = 'csv' | 'tsv' | 'parquet' | 'json' | 'jsonl' | 'xlsx' | 'arrow_ipc';

/** Lifecycle status of a registered data source */
export type DataSourceStatus = 'importing' | 'active' | 'stale' | 'error' | 'removed';

/** Lifecycle status of an ingestion job */
export type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** How an ingestion job was triggered */
export type IngestionTrigger = 'file_picker' | 'drag_and_drop' | 'watch_directory' | 'retry';

/**
 * Options controlling how a file is parsed during ingestion.
 * Passed to the DuckDB Worker alongside the file path and format.
 */
export interface IngestFileOptions {
  /** CSV/TSV: Override auto-detected delimiter. */
  readonly delimiter?: string | undefined;
  /** CSV/TSV: Override encoding detection. Default: 'utf-8'. */
  readonly encoding?: 'utf-8' | 'latin-1' | undefined;
  /** CSV: Whether first row is a header. Default: auto-detect. */
  readonly header?: boolean | undefined;
  /** JSON: Format hint. Default: 'auto'. */
  readonly jsonFormat?: 'auto' | 'array' | 'newline_delimited' | 'unstructured' | undefined;
  /** JSON: Maximum nesting depth for auto-flattening. Passed as `maximum_depth` to DuckDB `read_json()`. */
  readonly maxDepth?: number | undefined;
  /** XLSX: Sheet name or 0-based index. Default: first sheet. */
  readonly sheet?: string | number | undefined;
  /** Sample size for type inference. Default: 20480. */
  readonly sampleSize?: number | undefined;
  /** Whether to skip invalid rows instead of failing. Default: true. */
  readonly ignoreErrors?: boolean | undefined;
}

// ============================================================
// 3b. Ingestion IPC Request/Response Types
// ============================================================

/**
 * Request payload for `ingestion:importFiles` IPC channel.
 * Initiates import of one or more local files into DuckDB.
 *
 * @throws E2001 - File not found
 * @throws E2002 - Unsupported format
 * @throws E2003 - Permission denied
 */
export interface ImportFilesRequest {
  readonly type: 'ingestion:importFiles';
  /** Absolute paths to the files to import */
  readonly filePaths: readonly string[];
  /** How this import was initiated */
  readonly trigger: IngestionTrigger;
}

/** A single job entry returned in an ImportFilesResponse */
export interface ImportFilesResponseJob {
  /** Assigned IngestionJob.id */
  readonly jobId: string;
  /** Assigned DataSource.id */
  readonly dataSourceId: string;
  /** Absolute path to the imported file */
  readonly filePath: string;
  /** Detected file format */
  readonly format: DataSourceFormat;
}

/** Response payload for `ingestion:importFiles` IPC channel */
export interface ImportFilesResponse {
  readonly type: 'ingestion:importFiles:response';
  /** One job per requested file path */
  readonly jobs: readonly ImportFilesResponseJob[];
}

/** Request payload for `ingestion:cancelJob` IPC channel */
export interface CancelJobRequest {
  readonly type: 'ingestion:cancelJob';
  /** The ingestion job to cancel */
  readonly jobId: string;
}

/** Response payload for `ingestion:cancelJob` IPC channel */
export interface CancelJobResponse {
  readonly type: 'ingestion:cancelJob:response';
  /** The ingestion job that was targeted */
  readonly jobId: string;
  /** false if the job was already completed/failed */
  readonly cancelled: boolean;
}

/** Request payload for `ingestion:getProgress` IPC channel */
export interface GetProgressRequest {
  readonly type: 'ingestion:getProgress';
  /** The ingestion job to query */
  readonly jobId: string;
}

/** Response payload for `ingestion:getProgress` IPC channel */
export interface GetProgressResponse {
  readonly type: 'ingestion:getProgress:response';
  /** The queried ingestion job */
  readonly jobId: string;
  /** Current job status */
  readonly status: IngestionJobStatus;
  /** Cumulative rows imported so far */
  readonly rowsProcessed: number;
  /** Cumulative bytes of Arrow IPC data received */
  readonly bytesProcessed: number;
  /** Estimated total rows (extrapolated from first batch) */
  readonly estimatedTotalRows: number | undefined;
  /** Elapsed time in milliseconds */
  readonly durationMs: number;
  /** Error detail on failure */
  readonly errorMessage: string | undefined;
}

// ============================================================
// 3c. Catalog IPC Request/Response Types (Extended for Ingestion)
// ============================================================

/**
 * Request payload for `catalog:getSources` IPC channel.
 * Lists all data sources with optional filters.
 */
export interface GetSourcesRequest {
  readonly type: 'catalog:getSources';
  /** Optional filters to narrow the results */
  readonly filters?:
    | {
        readonly status?: readonly DataSourceStatus[] | undefined;
        readonly format?: readonly DataSourceFormat[] | undefined;
        readonly tags?: readonly string[] | undefined;
      }
    | undefined;
}

/** Response payload for `catalog:getSources` IPC channel */
export interface GetSourcesResponse {
  readonly type: 'catalog:getSources:response';
  /** Matching data sources */
  readonly sources: readonly DataSource[];
}

/**
 * Request payload for `catalog:removeSource` IPC channel.
 * Removes a data source and drops its DuckDB table.
 *
 * @throws E2010 - Source not found
 * @throws E2011 - Table drop failed
 */
export interface RemoveSourceRequest {
  readonly type: 'catalog:removeSource';
  /** The data source to remove */
  readonly dataSourceId: string;
}

/** Response payload for `catalog:removeSource` IPC channel */
export interface RemoveSourceResponse {
  readonly type: 'catalog:removeSource:response';
  /** The data source that was removed */
  readonly dataSourceId: string;
  /** DuckDB table that was dropped */
  readonly tableName: string;
  /** Whether the table was successfully dropped */
  readonly success: boolean;
}

/**
 * Request payload for `catalog:updateSource` IPC channel.
 * Updates data source metadata (name, tags).
 */
export interface UpdateSourceRequest {
  readonly type: 'catalog:updateSource';
  /** The data source to update */
  readonly dataSourceId: string;
  /** Fields to update */
  readonly updates: {
    readonly name?: string | undefined;
    readonly tags?: readonly string[] | undefined;
  };
}

/** Response payload for `catalog:updateSource` IPC channel */
export interface UpdateSourceResponse {
  readonly type: 'catalog:updateSource:response';
  /** The data source that was updated */
  readonly dataSourceId: string;
  /** The updated data source record */
  readonly source: DataSource;
}

/**
 * Request payload for `catalog:getColumnStats` IPC channel.
 * Computes or retrieves column statistics for a data source.
 */
export interface GetColumnStatsRequest {
  readonly type: 'catalog:getColumnStats';
  /** The data source to compute statistics for */
  readonly dataSourceId: string;
  /** DuckDB table name (fallback for restart recovery when in-memory map is cleared) */
  readonly tableName?: string | undefined;
  /** Ignore cached stats and recompute. Default: false. */
  readonly forceRecompute?: boolean | undefined;
}

/** Response payload for `catalog:getColumnStats` IPC channel */
export interface GetColumnStatsResponse {
  readonly type: 'catalog:getColumnStats:response';
  /** The data source these statistics belong to */
  readonly dataSourceId: string;
  /** Per-column statistics */
  readonly columns: readonly ColumnStatisticsRecord[];
  /** ISO 8601 timestamp when stats were computed */
  readonly computedAt: string;
  /** Computation duration in milliseconds */
  readonly durationMs: number;
}

// ============================================================
// 3d. Watch Directory IPC Request/Response Types
// ============================================================

/**
 * Request payload for `watch:addDirectory` IPC channel.
 * Configures a new watch directory for automatic file ingestion.
 *
 * @throws E2020 - Directory not found
 * @throws E2021 - Not a directory
 * @throws E2022 - Permission denied
 * @throws E2023 - Already watching
 */
export interface AddWatchDirectoryRequest {
  readonly type: 'watch:addDirectory';
  /** Absolute directory path to watch */
  readonly path: string;
  /** Watch configuration options */
  readonly options?:
    | {
        /** Watch subdirectories. Default: true. */
        readonly recursive?: boolean | undefined;
        /** Only ingest these formats. Default: all supported. */
        readonly fileTypeFilter?: readonly DataSourceFormat[] | undefined;
        /** Glob patterns to exclude. */
        readonly excludePatterns?: readonly string[] | undefined;
        /** Automatically re-ingest modified files. Default: false. */
        readonly autoReingest?: boolean | undefined;
        /** Stability threshold in ms before ingestion. Default: 2000. */
        readonly stabilityThresholdMs?: number | undefined;
      }
    | undefined;
}

/** Response payload for `watch:addDirectory` IPC channel */
export interface AddWatchDirectoryResponse {
  readonly type: 'watch:addDirectory:response';
  /** The newly created watch directory record */
  readonly watchDirectory: WatchDirectory;
}

/**
 * Request payload for `watch:removeDirectory` IPC channel.
 * Stops watching a directory and optionally removes associated sources.
 */
export interface RemoveWatchDirectoryRequest {
  readonly type: 'watch:removeDirectory';
  /** The watch directory to remove */
  readonly watchDirectoryId: string;
  /** Whether to remove data sources discovered from this directory. Default: false. */
  readonly removeAssociatedSources?: boolean | undefined;
}

/** Response payload for `watch:removeDirectory` IPC channel */
export interface RemoveWatchDirectoryResponse {
  readonly type: 'watch:removeDirectory:response';
  /** The watch directory that was removed */
  readonly watchDirectoryId: string;
  /** Number of associated sources removed (0 if removeAssociatedSources was false) */
  readonly sourcesRemoved: number;
}

/** Response payload for `watch:listDirectories` IPC channel */
export interface ListWatchDirectoriesResponse {
  readonly type: 'watch:listDirectories:response';
  /** All configured watch directories */
  readonly directories: readonly WatchDirectory[];
}

// ============================================================
// 3e. Push Event Types (webContents.send)
// ============================================================

/** Real-time progress update for an active ingestion job (Main -\> Renderer) */
export interface IngestionProgressEvent {
  readonly type: 'ingestion:progress';
  /** The ingestion job being tracked */
  readonly jobId: string;
  /** The data source being imported */
  readonly dataSourceId: string;
  /** Current job status */
  readonly status: IngestionJobStatus;
  /** Cumulative rows imported so far */
  readonly rowsProcessed: number;
  /** Cumulative bytes of Arrow IPC data received */
  readonly bytesProcessed: number;
  /** Estimated total rows (extrapolated from first batch) */
  readonly estimatedTotalRows: number | undefined;
  /** Elapsed time in milliseconds */
  readonly durationMs: number;
}

/** Notification when an ingestion job completes, fails, or is cancelled (Main -\> Renderer) */
export interface IngestionCompleteEvent {
  readonly type: 'ingestion:complete';
  /** The ingestion job that finished */
  readonly jobId: string;
  /** The data source that was imported */
  readonly dataSourceId: string;
  /** Terminal status */
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** Total rows in the imported table (undefined on failure) */
  readonly rowCount: number | undefined;
  /** Number of columns (undefined on failure) */
  readonly columnCount: number | undefined;
  /** Total elapsed time in milliseconds */
  readonly durationMs: number;
  /** Error detail on failure */
  readonly errorMessage: string | undefined;
  /** Error code (E2xxx) on failure */
  readonly errorCode: string | undefined;
}

/** Notification when a watched file is added, modified, or deleted (Main -\> Renderer) */
export interface WatchFileEvent {
  readonly type: 'watch:fileEvent';
  /** The watch directory that detected the event */
  readonly watchDirectoryId: string;
  /** Type of file system event */
  readonly eventType: 'add' | 'change' | 'unlink';
  /** Absolute path of the affected file */
  readonly filePath: string;
  /** Detected format (undefined for unlink events) */
  readonly format: DataSourceFormat | undefined;
}

/** Notification when a data source status changes (Main -\> Renderer) */
export interface CatalogSourceUpdatedEvent {
  readonly type: 'catalog:sourceUpdated';
  /** The data source whose status changed */
  readonly dataSourceId: string;
  /** New status */
  readonly status: DataSourceStatus;
  /** Previous status (unavailable when emitted by file watcher) */
  readonly previousStatus?: DataSourceStatus | undefined;
}

// ============================================================
// 4. Entity Types (Dexie.js Collections)
// ============================================================

// --- Tab State ---

/** Query tab content state */
export interface QueryTabState {
  sql: string;
  cursorPosition?: number | undefined;
  scrollTop?: number | undefined;
}

/** Catalog browser tab content state */
export interface CatalogTabState {
  selectedTable?: string | undefined;
  expandedNodes?: string[] | undefined;
}

/** Settings tab content state */
export interface SettingsTabState {
  section?: string | undefined;
}

/** Data grid tab content state (displays imported data source in Perspective grid) */
export interface DataGridTabState {
  /** Reference to data_sources.id */
  dataSourceId: string;
  /** DuckDB table name backing this grid */
  tableName: string;
}

/** Common fields shared by all tab variants */
interface BaseTab {
  /** UUID */
  id: string;
  /** Display order (0-based index in tab bar) */
  order: number;
  /** Tab display title */
  title: string;
  /** Whether this is the currently active tab */
  active: boolean;
  /** ISO timestamp of last interaction */
  lastAccessedAt: string;
}

/** Query editor tab */
export interface QueryTab extends BaseTab {
  type: 'query';
  state: QueryTabState;
}

/** Catalog browser tab */
export interface CatalogTab extends BaseTab {
  type: 'catalog';
  state: CatalogTabState;
}

/** Settings tab */
export interface SettingsTab extends BaseTab {
  type: 'settings';
  state: SettingsTabState;
}

/** Data grid tab for viewing imported data sources */
export interface DataGridTab extends BaseTab {
  type: 'data_grid';
  state: DataGridTabState;
}

/** Dexie.js `tabs` collection record — discriminated union on `type` */
export type Tab = QueryTab | CatalogTab | SettingsTab | DataGridTab;

// --- Query Execution ---

/** Query execution lifecycle status */
export type QueryExecutionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Dexie.js `queries` collection record */
export interface Query {
  /** UUID for this query execution */
  id: string;
  /** Reference to tabs.id */
  tabId: string;
  /** The SQL statement */
  sql: string;
  /** Execution lifecycle status */
  status: QueryExecutionStatus;
  /** ISO timestamp of execution start */
  startedAt: string;
  /** ISO timestamp of completion (if finished) */
  completedAt?: string | undefined;
  /** Duration in milliseconds */
  executionTimeMs?: number | undefined;
  /** Number of rows in the result set */
  rowCount?: number | undefined;
  /** Human-readable error if status is 'failed' */
  errorMessage?: string | undefined;
  /** Error taxonomy code (E1xxx-E9xxx) */
  errorCode?: string | undefined;
}

// --- Catalog ---

/** Catalog entry representing a registered DuckDB table or view */
export interface CatalogEntry {
  /** UUID identifier */
  id: string;
  /** DuckDB table/view name */
  name: string;
  /** DuckDB schema (always 'main' in Phase 1) */
  schema: string;
  /** 'table' for persistent tables, 'view' for SQL views */
  type: 'table' | 'view';
  /** Current status */
  status: 'active' | 'removed' | 'error';
  /** Estimated row count */
  rowCount: number;
  /** Estimated storage size in bytes */
  sizeBytes: number;
  /** Number of columns */
  columnCount: number;
  /** ISO timestamp of registration */
  registeredAt: string;
  /** ISO timestamp of last query against this table */
  lastAccessedAt?: string | undefined;
}

/** Column schema information */
export interface ColumnSchema {
  /** Column name */
  name: string;
  /** DuckDB type (e.g., VARCHAR, INTEGER, DECIMAL(10,2), TIMESTAMP) */
  duckdbType: string;
  /** Arrow type equivalent (e.g., Utf8, Int32, Float64, Timestamp(us, UTC)) */
  arrowType: string;
  /** Whether column allows NULL values */
  nullable: boolean;
  /** 0-based position in the table */
  ordinalPosition: number;
}

/** Dexie.js `column_schemas` collection record (extends ColumnSchema for storage) */
export interface ColumnSchemaRecord {
  /** Composite key: `{catalogEntryId}_{columnName}` */
  id: string;
  /** Reference to catalog_entries.id */
  catalogEntryId: string;
  /** Column name in DuckDB */
  columnName: string;
  /** DuckDB type (e.g., VARCHAR, INTEGER, TIMESTAMP) */
  columnType: string;
  /** Arrow type equivalent (e.g., Utf8, Int32, Float64) */
  arrowType: string;
  /** Whether column allows NULL */
  nullable: boolean;
  /** Column order in the table */
  ordinalPosition: number;
}

// --- Query History ---

/** Dexie.js `query_history` collection record (UI-side mirror of DuckDB _query_history) */
export interface QueryHistoryRecord {
  /** Matches _query_history.query_id in DuckDB */
  id: string;
  /** The SQL statement */
  sql: string;
  /** Duration in milliseconds */
  executionTimeMs: number;
  /** Result set row count */
  rowCount: number;
  /** ISO timestamp of execution */
  timestamp: string;
  /** Origin: 'user' or 'system' */
  source: 'user' | 'system';
  /** User-assigned tags */
  tags: string[];
  /** Execution outcome */
  status: 'success' | 'error';
  /** Error details if applicable */
  errorMessage?: string | undefined;
}

/** Lightweight query history record pushed from DuckDB Worker -\> Main -\> Renderer */
export interface QueryHistoryPushRecord {
  /** Matches _query_history.query_id in DuckDB */
  queryId: string;
  /** The SQL statement */
  sql: string;
  /** Duration in milliseconds */
  executionTimeMs: number;
  /** Result set row count */
  rowCount: number;
  /** Execution outcome */
  status: 'success' | 'error';
  /** Error details if applicable */
  errorMessage?: string | undefined;
}

// --- Preferences ---

/** Dexie.js `preferences` collection record */
export interface Preference {
  /** Dot-notated key (e.g., 'appearance.theme', 'editor.fontSize') */
  id: string;
  /** Setting value (type depends on the key) */
  value: unknown;
  /** Grouping category */
  category: 'appearance' | 'editor' | 'memory' | 'advanced';
  /** ISO timestamp of last change */
  updatedAt: string;
}

// --- Worker Health ---

/** Dexie.js `worker_health` collection record */
export interface WorkerHealthRecord {
  /** Worker identifier: 'duckdb' in Phase 1 */
  id: string;
  /** Current health status */
  status: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';
  /** Number of automatic restarts since app launch */
  restartCount: number;
  /** ISO timestamp of last successful heartbeat */
  lastHeartbeatAt: string;
  /** Most recent error message (if any) */
  lastErrorMessage?: string | undefined;
  /** ISO timestamp when the worker last started */
  upSince: string;
  /** Number of queries currently executing */
  activeQueryCount: number;
}

// --- Recovery Log ---

/** Dexie.js `recovery_log` collection record */
export interface RecoveryLogEntry {
  /** UUID */
  id: string;
  /** ISO timestamp of detection */
  timestamp: string;
  /** Recovery event type */
  type: 'abnormal_shutdown' | 'integrity_check' | 'worker_restart' | 'wal_recovery';
  /** Human-readable description of what happened */
  details: string;
  /** Recovery outcome */
  outcome: 'recovered' | 'degraded' | 'failed';
  /** Worker ID that was affected (if applicable) */
  affectedWorker?: string | undefined;
}

// --- Application State ---

/** Dexie.js `app_state` collection record */
export interface AppStateEntry {
  /** State key (e.g., 'shutdown_status', 'window_bounds', 'session_id') */
  id: string;
  /** State value */
  value: unknown;
  /** ISO timestamp of last update */
  updatedAt: string;
}

// --- Data Sources (Ingestion) ---

/**
 * Dexie.js `data_sources` collection record.
 * Represents a registered data file with its metadata and lifecycle status.
 */
export interface DataSource {
  /** UUID v4 primary key */
  readonly id: string;
  /** Display name (defaults to filename without extension, user-renamable) */
  readonly name: string;
  /** Absolute path to the source file on disk */
  readonly filePath: string;
  /** Detected file format */
  readonly format: DataSourceFormat;
  /** Lifecycle status */
  readonly status: DataSourceStatus;
  /** Name of the materialized DuckDB table (set after import) */
  readonly duckdbTableName?: string | undefined;
  /** Name of the preview DuckDB view (set during preview) */
  readonly duckdbViewName?: string | undefined;
  /** Total rows after import */
  readonly rowCount?: number | undefined;
  /** Number of columns */
  readonly columnCount?: number | undefined;
  /** File size at time of import in bytes */
  readonly fileSizeBytes?: number | undefined;
  /** ISO 8601 timestamp of file's last modification at import time */
  readonly fileModifiedAt?: string | undefined;
  /** FK to WatchDirectory if auto-discovered */
  readonly watchDirectoryId?: string | undefined;
  /** User-assigned tags for filtering */
  readonly tags: readonly string[];
  /** Error description when status is 'error' */
  readonly errorMessage?: string | undefined;
  /** Error code (E2xxx) when status is 'error' */
  readonly errorCode?: string | undefined;
  /** XLSX: name of the imported sheet (defaults to first sheet) */
  readonly sheetName?: string | undefined;
  /** ISO 8601 timestamp of creation */
  readonly createdAt: string;
  /** ISO 8601 timestamp of last update */
  readonly updatedAt: string;
}

/**
 * Dexie.js `ingestion_jobs` collection record.
 * Tracks a single file import operation with progress, cancellation support, and error reporting.
 */
export interface IngestionJob {
  /** UUID v4 primary key */
  readonly id: string;
  /** FK to DataSource */
  readonly dataSourceId: string;
  /** Job lifecycle status */
  readonly status: IngestionJobStatus;
  /** Absolute path being imported */
  readonly filePath: string;
  /** Detected format */
  readonly format: DataSourceFormat;
  /** Source file size for progress estimation */
  readonly fileSizeBytes?: number | undefined;
  /** Cumulative rows imported so far (defaults to 0) */
  readonly rowsProcessed: number;
  /** Arrow IPC batches received (defaults to 0) */
  readonly batchesReceived: number;
  /** Cumulative bytes of Arrow IPC data received (defaults to 0) */
  readonly bytesProcessed: number;
  /** Estimated total rows (extrapolated from first batch) */
  readonly estimatedTotalRows?: number | undefined;
  /** Error detail on failure */
  readonly errorMessage?: string | undefined;
  /** Error code (E2xxx) on failure */
  readonly errorCode?: string | undefined;
  /** ISO 8601 timestamp of job start */
  readonly startedAt: string;
  /** ISO 8601 timestamp of job completion */
  readonly completedAt?: string | undefined;
  /** Total elapsed time in milliseconds */
  readonly durationMs?: number | undefined;
  /** How the import was initiated */
  readonly triggeredBy: IngestionTrigger;
}

/**
 * Dexie.js `watch_directories` collection record.
 * A configured folder path with settings for automatic file discovery and ingestion.
 */
export interface WatchDirectory {
  /** UUID v4 primary key */
  readonly id: string;
  /** Absolute directory path (must exist and be readable) */
  readonly path: string;
  /** User-friendly label (defaults to directory basename) */
  readonly displayName: string;
  /** Whether the watcher is currently running */
  readonly isActive: boolean;
  /** Watch subdirectories (defaults to true) */
  readonly recursive: boolean;
  /** Only ingest these formats (defaults to all supported formats) */
  readonly fileTypeFilter: readonly DataSourceFormat[];
  /** Glob patterns to exclude (defaults to []) */
  readonly excludePatterns: readonly string[];
  /** Automatically re-ingest modified files (defaults to false) */
  readonly autoReingest: boolean;
  /** How long a file must be unchanged before ingestion in ms (defaults to 2000) */
  readonly stabilityThresholdMs: number;
  /** Number of data sources discovered from this directory (defaults to 0) */
  readonly sourceCount: number;
  /** ISO 8601 timestamp of last completed scan */
  readonly lastScanAt?: string | undefined;
  /** ISO 8601 timestamp of creation */
  readonly createdAt: string;
  /** ISO 8601 timestamp of last update */
  readonly updatedAt: string;
}

/** A single top-frequent value entry for categorical column statistics */
export interface TopValue {
  /** The value (rendered as string for universal display) */
  readonly value: string;
  /** Number of occurrences */
  readonly count: number;
  /** Percentage of total rows (count / rowCount * 100) */
  readonly percentage: number;
}

/**
 * Dexie.js `column_statistics` collection record.
 * Per-column statistical summaries computed by DuckDB SUMMARIZE and custom aggregates.
 */
export interface ColumnStatisticsRecord {
  /** Composite key: `{dataSourceId}__{columnName}` */
  readonly id: string;
  /** FK to DataSource */
  readonly dataSourceId: string;
  /** Column name */
  readonly columnName: string;
  /** DuckDB data type (e.g. 'INTEGER', 'VARCHAR', 'DECIMAL(10,2)') */
  readonly columnType: string;
  /** Total rows in the table */
  readonly rowCount: number;
  /** Number of NULL values */
  readonly nullCount: number;
  /** Percentage of NULL values (nullCount / rowCount * 100) */
  readonly nullPercentage: number;
  /** Approximate distinct values (HyperLogLog) */
  readonly distinctCount: number;
  /** Minimum value (as string for universal display) */
  readonly min?: string | undefined;
  /** Maximum value (as string for universal display) */
  readonly max?: string | undefined;
  /** Arithmetic mean (numeric columns only) */
  readonly mean?: number | undefined;
  /** Median / q50 (numeric columns only) */
  readonly median?: number | undefined;
  /** Sample standard deviation (numeric columns only) */
  readonly stddev?: number | undefined;
  /** 25th percentile (numeric columns only) */
  readonly q25?: number | undefined;
  /** 75th percentile (numeric columns only) */
  readonly q75?: number | undefined;
  /** Top-N frequent values (categorical columns only) */
  readonly topValues?: readonly TopValue[] | undefined;
  /** ISO 8601 timestamp when stats were computed */
  readonly computedAt: string;
}

// ============================================================
// 5. API Types (Preload Bridge Surface)
// ============================================================

/** A single Arrow IPC batch received from the data plane (preload API shape) */
export interface ArrowBatch {
  /** Arrow IPC ArrayBuffer containing RecordBatch data */
  buffer: ArrayBuffer;
  /** 0-based batch sequence number */
  index: number;
  /** Number of rows in this batch */
  rowCount: number;
  /** Size in bytes */
  byteSize: number;
  /** Whether this is the last batch */
  isLast: boolean;
  /** Error details when batch represents a data-plane error */
  error?: { code: string; message: string } | undefined;
  /** Human-readable status for non-result statements (DDL/DML success) */
  statusMessage?: string | undefined;
}

/** Worker health status pushed from Main Process to Renderer */
export interface WorkerHealth {
  /** Worker identifier ('duckdb' in Phase 1) */
  worker: 'duckdb';
  /** Derived health status */
  status: WorkerHealthStatus;
  /** Number of automatic restarts since app launch */
  restartCount?: number | undefined;
  /** Human-readable status message */
  message?: string | undefined;
}

/** Worker health status values */
export type WorkerHealthStatus = 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';

/** Application state information returned by lifecycle.getAppState() */
export interface AppState {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  userDataPath: string;
  memory: {
    totalSystemMB: number;
    freeSystemMB: number;
    duckdbLimitMB: number;
  };
  workers: {
    duckdb: WorkerHealthStatus;
  };
  shutdownStatus: 'clean' | 'dirty';
}

/** Standard IPC error response format */
export interface IPCError {
  /** Structured error code (E1xxx-E9xxx) */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether the client should retry this operation */
  retryable: boolean;
  /** Suggested retry delay in milliseconds (present if retryable) */
  retryAfterMs?: number | undefined;
  /** Additional context for debugging */
  details?: Record<string, unknown> | undefined;
  /** Stack trace (development mode only) */
  stack?: string | undefined;
}

// ============================================================
// 6. Configuration
// ============================================================

/** Root configuration schema — defined by Zod in schemas/config-schema.ts */
export type { DuckspaceConfig } from './schemas/config-schema';

// ============================================================
// 7. Preload Bridge API Namespace Types
// ============================================================

/**
 * Query namespace for executing and monitoring SQL queries.
 * Methods delegate to IPC channels and the data plane MessagePort.
 */
export interface QueryNamespace {
  /**
   * Execute a SQL query and return a handle for tracking results.
   *
   * @param sql - SQL string to execute.
   * @param params - Optional positional parameter values.
   * @returns A QueryHandle with the assigned queryId.
   */
  execute(sql: string, params?: unknown[]): Promise<QueryHandle>;

  /**
   * Cancel a running query.
   *
   * @param queryId - Identifier of the query to cancel.
   */
  cancel(queryId: string): Promise<void>;

  /**
   * Subscribe to query status change events.
   *
   * @param callback - Invoked with the updated QueryStatus on each change.
   * @returns An unsubscribe function.
   */
  onStatus(callback: (status: QueryStatus) => void): () => void;

  /**
   * Subscribe to Arrow IPC data batches for a specific query.
   *
   * @param queryId - The query to receive data for.
   * @param callback - Invoked with each ArrowBatch as it arrives.
   * @returns An unsubscribe function.
   */
  onData(queryId: string, callback: (batch: ArrowBatch) => void): () => void;

  /**
   * Subscribe to query history records pushed from the Main process.
   *
   * @param callback - Invoked with each QueryHistoryPushRecord.
   * @returns An unsubscribe function.
   */
  onQueryHistory(callback: (record: QueryHistoryPushRecord) => void): () => void;
}

/**
 * Catalog namespace for browsing DuckDB tables and schemas,
 * and managing data sources from local file ingestion.
 */
export interface CatalogNamespace {
  /**
   * List all registered tables and views.
   *
   * @returns Array of CatalogEntry objects.
   */
  listTables(): Promise<CatalogEntry[]>;

  /**
   * Get column schema information for a specific table.
   *
   * @param tableName - Name of the table to describe.
   * @returns Array of ColumnSchema objects.
   */
  describeTable(tableName: string): Promise<ColumnSchema[]>;

  /**
   * Preview sample rows from a table, returned as Arrow IPC batches.
   *
   * @param tableName - Name of the table to preview.
   * @param limit - Maximum number of rows to return (default: 10,000).
   * @returns A PreviewHandle with the query ID and effective limit info.
   */
  previewTable(tableName: string, limit?: number): Promise<PreviewHandle>;

  /**
   * List all data sources with optional filters.
   *
   * @param filters - Optional filters by status, format, or tags.
   * @returns Array of DataSource objects matching the filters.
   */
  getSources(filters?: GetSourcesRequest['filters']): Promise<DataSource[]>;

  /**
   * Remove a data source and drop its DuckDB table.
   *
   * @param dataSourceId - The data source to remove.
   * @returns Removal result with the dropped table name.
   * @throws E2010 - Source not found
   * @throws E2011 - Table drop failed
   */
  removeSource(dataSourceId: string): Promise<RemoveSourceResponse>;

  /**
   * Update data source metadata (name, tags).
   *
   * @param dataSourceId - The data source to update.
   * @param updates - Fields to update.
   * @returns The updated data source record.
   */
  updateSource(dataSourceId: string, updates: UpdateSourceRequest['updates']): Promise<DataSource>;

  /**
   * Compute or retrieve column statistics for a data source.
   *
   * @param dataSourceId - The data source to compute statistics for.
   * @param forceRecompute - Ignore cached stats and recompute. Default: false.
   * @returns Column statistics with computation metadata.
   */
  getColumnStats(
    dataSourceId: string,
    forceRecompute?: boolean,
    tableName?: string,
  ): Promise<GetColumnStatsResponse>;

  /**
   * Subscribe to data source status change events.
   *
   * @param callback - Invoked when a data source status changes.
   * @returns An unsubscribe function.
   */
  onSourceUpdated(callback: (event: CatalogSourceUpdatedEvent) => void): () => void;
}

/**
 * Lifecycle namespace for application state management and shutdown coordination.
 */
export interface LifecycleNamespace {
  /**
   * Signal to Main that the Renderer is fully initialized and ready.
   */
  ready(): Promise<void>;

  /**
   * Retrieve the current application state snapshot from Main.
   *
   * @returns The current AppState.
   */
  getAppState(): Promise<AppState>;

  /**
   * Acknowledge that the Renderer has completed shutdown preparation.
   */
  shutdownAck(): Promise<void>;

  /**
   * Subscribe to DuckDB worker health status updates.
   *
   * @param callback - Invoked with the latest WorkerHealth on each update.
   * @returns An unsubscribe function.
   */
  onWorkerHealth(callback: (health: WorkerHealth) => void): () => void;

  /**
   * Subscribe to shutdown preparation signals from Main.
   *
   * @param callback - Invoked when Main begins the shutdown sequence.
   * @returns An unsubscribe function.
   */
  onShutdownPrepare(callback: () => void): () => void;

  /**
   * Subscribe to window bounds change events.
   *
   * @param callback - Invoked with the new bounds when the window is moved or resized.
   * @returns An unsubscribe function.
   */
  onBoundsChanged(
    callback: (bounds: { x: number; y: number; width: number; height: number }) => void,
  ): () => void;
}

/**
 * Ingestion namespace for importing local files into DuckDB.
 * Methods delegate to IPC channels for file import, cancellation, and progress tracking.
 */
export interface IngestionNamespace {
  /**
   * Import one or more local files into DuckDB and register in the catalog.
   *
   * @param filePaths - Absolute paths to the files to import.
   * @param trigger - How this import was initiated.
   * @returns One job entry per requested file path.
   * @throws E2001 - File not found
   * @throws E2002 - Unsupported format
   * @throws E2003 - Permission denied
   */
  importFiles(
    filePaths: readonly string[],
    trigger: IngestionTrigger,
    dataSourceId?: string,
  ): Promise<ImportFilesResponse>;

  /**
   * Cancel an in-progress ingestion job.
   *
   * @param jobId - The ingestion job to cancel.
   * @returns Whether the job was successfully cancelled.
   */
  cancelJob(jobId: string): Promise<CancelJobResponse>;

  /**
   * Get current progress for an active ingestion job.
   *
   * @param jobId - The ingestion job to query.
   * @returns Current progress snapshot.
   */
  getProgress(jobId: string): Promise<GetProgressResponse>;

  /**
   * Subscribe to real-time ingestion progress events.
   *
   * @param callback - Invoked with progress updates for active jobs.
   * @returns An unsubscribe function.
   */
  onProgress(callback: (event: IngestionProgressEvent) => void): () => void;

  /**
   * Subscribe to ingestion completion events (success, failure, or cancellation).
   *
   * @param callback - Invoked when an ingestion job reaches a terminal state.
   * @returns An unsubscribe function.
   */
  onComplete(callback: (event: IngestionCompleteEvent) => void): () => void;
}

/**
 * Watch namespace for configuring and managing directory watchers.
 * Methods delegate to IPC channels for adding, removing, and listing watch directories.
 */
export interface WatchNamespace {
  /**
   * Configure a new watch directory for automatic file ingestion.
   *
   * @param path - Absolute directory path to watch.
   * @param options - Watch configuration options.
   * @returns The newly created watch directory record.
   * @throws E2020 - Directory not found
   * @throws E2021 - Not a directory
   * @throws E2022 - Permission denied
   * @throws E2023 - Already watching
   */
  addDirectory(
    path: string,
    options?: AddWatchDirectoryRequest['options'],
  ): Promise<WatchDirectory>;

  /**
   * Stop watching a directory and optionally remove associated sources.
   *
   * @param watchDirectoryId - The watch directory to remove.
   * @param removeAssociatedSources - Whether to also remove discovered sources. Default: false.
   * @returns Removal result with count of sources removed.
   */
  removeDirectory(
    watchDirectoryId: string,
    removeAssociatedSources?: boolean,
  ): Promise<RemoveWatchDirectoryResponse>;

  /**
   * List all configured watch directories.
   *
   * @returns Array of WatchDirectory objects.
   */
  listDirectories(): Promise<WatchDirectory[]>;

  /**
   * Restore previously configured watch directories on app restart.
   * The Main process re-creates chokidar watchers for each provided config.
   *
   * @param directories - Watch directory configs to restore.
   * @returns Count of successfully restored directories.
   */
  restoreDirectories(directories: readonly WatchDirectory[]): Promise<number>;

  /**
   * Subscribe to file system events from watched directories.
   *
   * @param callback - Invoked when a watched file is added, modified, or deleted.
   * @returns An unsubscribe function.
   */
  onFileEvent(callback: (event: WatchFileEvent) => void): () => void;
}

/**
 * Root API interface exposed to the Renderer as `window.duckspace`.
 * Provides namespaced access to query execution, catalog browsing,
 * file ingestion, directory watching, and lifecycle management.
 */
export interface DuckspaceAPI {
  /** Query execution and data streaming. */
  query: QueryNamespace;
  /** Table catalog browsing, schema inspection, and data source management. */
  catalog: CatalogNamespace;
  /** Application lifecycle, health monitoring, and shutdown. */
  lifecycle: LifecycleNamespace;
  /** Local file ingestion, progress tracking, and cancellation. */
  ingestion: IngestionNamespace;
  /** Directory watching for automatic file discovery. */
  watch: WatchNamespace;
}

/**
 * Exhaustiveness guard for discriminated union switches.
 * @param x - The value that should be `never` if all variants are handled.
 * @throws Always throws at runtime if reached.
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}

// ============================================================
// Global Window Augmentation
// ============================================================

declare global {
  interface Window {
    duckspace: DuckspaceAPI;
  }
}
