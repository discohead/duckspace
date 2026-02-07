/**
 * Shared type definitions for the datspace Electron application.
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
 *   3. Worker Control Messages (Main <-> DuckDB Worker)
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
  params?: unknown[];
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
  rowsScanned?: number;
  /** Rows after filter application */
  rowsFiltered?: number;
  /** Number of Arrow batches streamed to Renderer */
  batchesStreamed: number;
  /** Estimated total batches (null if unknown) */
  estimatedTotalBatches?: number;
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
  /** Number of sample rows (default: 100) */
  limit?: number;
}

/** Response payload for `catalog:preview` IPC channel */
export interface CatalogPreviewResponse {
  /** Query ID for receiving data on the MessagePort */
  queryId: string;
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
  totalBatches?: number;
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
  reason?: 'user_cancelled' | 'component_unmounted' | 'timeout' | 'superseded';
}

/** Union of all data plane message types flowing over the duckdb-data MessagePort */
export type DataPlaneMessage =
  | ArrowBatchMessage
  | StreamEndMessage
  | DataPlaneError
  | BatchAckMessage
  | DataPlaneCancelMessage;

// ============================================================
// 3. Worker Control Messages (Main <-> DuckDB Worker)
// ============================================================

/** Main -> DuckDB Worker: Execute SQL query */
export interface WorkerQueryRequest {
  type: 'execute_query';
  /** UUID assigned by QueryRouter */
  queryId: string;
  /** Parameterized SQL with $1, $2, ... placeholders */
  sql: string;
  /** Parameter values for binding */
  params?: unknown[];
  /** Execution options */
  options?: {
    /** Query timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Override default batch size */
    batchSize?: number;
    /** Whether this is a read-only query (default: true) */
    readOnly?: boolean;
  };
}

/** Main -> DuckDB Worker: Cancel a running query */
export interface WorkerCancelRequest {
  type: 'cancel_query';
  queryId: string;
}

/** Main -> DuckDB Worker: Get table information */
export interface WorkerGetTableInfoRequest {
  type: 'get_table_info';
  tableName: string;
}

/** DuckDB Worker -> Main: Table info response */
export interface WorkerGetTableInfoResponse {
  type: 'table_info';
  tableName: string;
  columns: ColumnSchema[];
  rowCount: number;
  sizeBytes: number;
}

/** DuckDB Worker -> Main: Catalog update after table registration */
export interface WorkerCatalogUpdate {
  type: 'catalog_update';
  table: string;
  columns: ColumnSchema[];
  rowCount: number;
  sizeBytes: number;
  sourceId: string;
  registrationType: 'table' | 'view';
}

/** Worker -> Main: Initialization complete */
export interface WorkerReadyMessage {
  type: 'ready';
  worker: 'duckdb';
  metadata?: {
    duckdbVersion?: string;
    extensionsLoaded?: string[];
    tableCount?: number;
  };
}

/** Main -> Worker: Request graceful shutdown */
export interface ShutdownRequest {
  type: 'shutdown';
}

/** Worker -> Main: Shutdown complete */
export interface ShutdownComplete {
  type: 'shutdown-complete';
  worker: 'duckdb';
}

/** Main -> DuckDB Worker: Update runtime configuration */
export interface WorkerConfigUpdate {
  type: 'configure';
  settings: {
    memory_limit?: string;
    threads?: number;
    temp_directory?: string;
  };
}

/** Main -> DuckDB Worker: Health check */
export interface WorkerHealthCheck {
  type: 'health_check';
}

/** DuckDB Worker -> Main: Health check response */
export interface WorkerHealthResponse {
  type: 'health_check_result';
  status: 'healthy' | 'degraded' | 'failed';
  tables: number;
  memoryUsedMB: number;
  activeQueries: number;
}

/** Main -> DuckDB Worker: Heartbeat ping */
export interface HeartbeatRequest {
  type: 'heartbeat';
  /** Monotonic timestamp for latency measurement */
  sentAt: number;
}

/** DuckDB Worker -> Main: Heartbeat response */
export interface HeartbeatAck {
  type: 'heartbeat_ack';
  /** Echo back the sentAt timestamp */
  sentAt: number;
  /** Worker's self-reported health */
  status: 'healthy' | 'degraded' | 'busy';
  /** Optional diagnostics */
  details?: {
    activeQueries?: number;
    memoryUsageMB?: number;
    uptime?: number;
  };
}

/** Union of all worker control messages flowing over parentPort */
export type WorkerMessage =
  | WorkerQueryRequest
  | WorkerCancelRequest
  | WorkerGetTableInfoRequest
  | WorkerGetTableInfoResponse
  | WorkerCatalogUpdate
  | WorkerReadyMessage
  | ShutdownRequest
  | ShutdownComplete
  | WorkerConfigUpdate
  | WorkerHealthCheck
  | WorkerHealthResponse
  | HeartbeatRequest
  | HeartbeatAck;

// ============================================================
// 4. Entity Types (Dexie.js Collections)
// ============================================================

// --- Tab State ---

/** Query tab content state */
export interface QueryTabState {
  sql: string;
  cursorPosition?: number;
  scrollTop?: number;
}

/** Catalog browser tab content state */
export interface CatalogTabState {
  selectedTable?: string;
  expandedNodes?: string[];
}

/** Settings tab content state */
export interface SettingsTabState {
  section?: string;
}

/** Dexie.js `tabs` collection record */
export interface Tab {
  /** UUID */
  id: string;
  /** Tab content type */
  type: 'query' | 'catalog' | 'settings';
  /** Display order (0-based index in tab bar) */
  order: number;
  /** Tab display title */
  title: string;
  /** Whether this is the currently active tab */
  active: boolean;
  /** Tab-type-specific state */
  state: QueryTabState | CatalogTabState | SettingsTabState;
  /** ISO timestamp of last interaction */
  lastAccessedAt: string;
}

// --- Query Execution ---

/** Query execution lifecycle status */
export type QueryExecutionStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  completedAt?: string;
  /** Duration in milliseconds */
  executionTimeMs?: number;
  /** Number of rows in the result set */
  rowCount?: number;
  /** Human-readable error if status is 'failed' */
  errorMessage?: string;
  /** Error taxonomy code (E1xxx-E9xxx) */
  errorCode?: string;
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
  lastAccessedAt?: string;
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
  /** Composite key: {catalogEntryId}_{columnName} */
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
  errorMessage?: string;
}

/** Lightweight query history record pushed from DuckDB Worker -> Main -> Renderer */
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
  errorMessage?: string;
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
  lastErrorMessage?: string;
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
  affectedWorker?: string;
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
}

/** Worker health status pushed from Main Process to Renderer */
export interface WorkerHealth {
  /** Worker identifier ('duckdb' in Phase 1) */
  worker: 'duckdb';
  /** Derived health status */
  status: WorkerHealthStatus;
  /** Number of automatic restarts since app launch */
  restartCount?: number;
  /** Human-readable status message */
  message?: string;
}

/** Worker health status values */
export type WorkerHealthStatus =
  | 'ready'
  | 'busy'
  | 'degraded'
  | 'restarting'
  | 'failed';

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
  retryAfterMs?: number;
  /** Additional context for debugging */
  details?: Record<string, unknown>;
  /** Stack trace (development mode only) */
  stack?: string;
}

// ============================================================
// 6. Configuration
// ============================================================

/** Root configuration schema for config.json */
export interface DatspaceConfig {
  /** DuckDB memory and threading configuration */
  duckdb: {
    /** Percentage of system RAM to allocate (10-90) */
    memoryLimitPercent: number;
    /** Explicit MB override (null = use percent) */
    memoryLimitOverrideMB: number | null;
    /** Thread count (null = os.cpus().length - 2) */
    threads: number | null;
    /** Extensions to load at startup */
    extensions: string[];
  };
  /** Application paths (relative to userData) */
  paths: {
    /** Database filename */
    database: string;
    /** Temp/spill directory */
    tempDir: string;
    /** Config file (self-reference) */
    config: string;
  };
  /** Worker health monitoring settings */
  workers: {
    /** How often to ping workers in ms (>= 5000) */
    healthCheckIntervalMs: number;
    /** Max wait for health check response in ms (>= 1000) */
    heartbeatTimeoutMs: number;
    /** Auto-restart limit before marking 'failed' (>= 1) */
    maxRestartAttempts: number;
    /** V8 heap limit for worker threads in MB (>= 128) */
    v8HeapLimitMB: number;
  };
  /** UI preferences (also mirrored in Dexie.js preferences collection) */
  ui: {
    /** Color theme */
    theme: 'light' | 'dark' | 'system';
    /** Base font size in pixels (10-24) */
    fontSize: number;
    /** Default LIMIT for unbounded SELECTs (>= 0) */
    defaultQueryLimit: number;
  };
  /** Application lifecycle settings */
  lifecycle: {
    /** Max time for graceful shutdown in ms (>= 2000) */
    shutdownTimeoutMs: number;
    /** Run CHECKPOINT before closing DuckDB */
    walCheckpointOnShutdown: boolean;
  };
}

// ============================================================
// Preload Bridge API Namespace Types
// ============================================================

/** Query namespace of the preload bridge API */
export interface QueryNamespace {
  execute(sql: string, params?: unknown[]): Promise<QueryHandle>;
  cancel(queryId: string): Promise<void>;
  onStatus(callback: (status: QueryStatusEvent) => void): () => void;
  onData(queryId: string, callback: (batch: ArrowBatch) => void): () => void;
  onQueryHistory(callback: (record: QueryHistoryPushRecord) => void): () => void;
}

/** Catalog namespace of the preload bridge API */
export interface CatalogNamespace {
  listTables(): Promise<CatalogEntry[]>;
  describeTable(tableName: string): Promise<ColumnSchema[]>;
  previewTable(tableName: string, limit?: number): Promise<QueryHandle>;
}

/** Lifecycle namespace of the preload bridge API */
export interface LifecycleNamespace {
  ready(): Promise<void>;
  getAppState(): Promise<AppState>;
  shutdownAck(): Promise<void>;
  onWorkerHealth(callback: (health: WorkerHealth) => void): () => void;
  onShutdownPrepare(callback: () => void): () => void;
  onBoundsChanged(callback: (bounds: { x: number; y: number; width: number; height: number }) => void): () => void;
}

/** Complete preload bridge API exposed as window.datspace */
export interface DatspaceAPI {
  query: QueryNamespace;
  catalog: CatalogNamespace;
  lifecycle: LifecycleNamespace;
}

// ============================================================
// Global Window Augmentation
// ============================================================

declare global {
  interface Window {
    datspace: DatspaceAPI;
  }
}
