/**
 * Type definitions for the Datspace preload bridge API.
 *
 * These interfaces define the `window.datspace` object exposed to the Renderer
 * via `contextBridge.exposeInMainWorld`. Organized into three namespaces:
 * query, catalog, and lifecycle.
 */

import type {
  AppState,
  ArrowBatch,
  CatalogEntry,
  ColumnSchema,
  QueryHandle,
  QueryHistoryPushRecord,
  QueryStatus,
  WorkerHealth,
} from '@shared/types';

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
