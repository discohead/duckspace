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
  /** Number of sample rows (default: 100) */
  limit?: number | undefined;
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
  metadata?:
    | {
        duckdbVersion?: string | undefined;
        extensionsLoaded?: string[] | undefined;
        tableCount?: number | undefined;
        integrityOk?: boolean | undefined;
      }
    | undefined;
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
    memory_limit?: string | undefined;
    threads?: number | undefined;
    temp_directory?: string | undefined;
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

/** Dexie.js `tabs` collection record — discriminated union on `type` */
export type Tab = QueryTab | CatalogTab | SettingsTab;

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
  errorMessage?: string | undefined;
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
export type { DatspaceConfig } from './schemas/config-schema';

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
 * Catalog namespace for browsing DuckDB tables and schemas.
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
   * @param limit - Maximum number of rows to return (default: 100).
   * @returns A QueryHandle for the preview query.
   */
  previewTable(tableName: string, limit?: number): Promise<QueryHandle>;
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
 * Root API interface exposed to the Renderer as `window.datspace`.
 * Provides namespaced access to query execution, catalog browsing, and lifecycle management.
 */
export interface DatspaceAPI {
  /** Query execution and data streaming. */
  query: QueryNamespace;
  /** Table catalog browsing and schema inspection. */
  catalog: CatalogNamespace;
  /** Application lifecycle, health monitoring, and shutdown. */
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
