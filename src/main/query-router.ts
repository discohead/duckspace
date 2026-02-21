import { randomUUID } from 'node:crypto';
import type { Worker } from 'node:worker_threads';
import { PUSH_EVENTS, TIMEOUTS } from '@shared/constants';
import { shuttingDownError } from '@shared/errors';
import type {
  CatalogEntry,
  ColumnSchema,
  PreviewHandle,
  QueryHandle,
  QueryStatusEvent,
} from '@shared/types';
import type { BrowserWindow } from 'electron';

/**
 * Default row limit for preview queries.
 *
 * DuckDB's nanoarrow extension crashes (SIGTRAP in `ArrowScalarData::Initialize`)
 * when `to_arrow_ipc()` processes ~200,000+ rows inside Electron's runtime.
 * With synthetic data the boundary is exactly 200,000; with real data
 * (variable-length VARCHARs) the threshold is lower. 100k is confirmed safe
 * with 58-column CSV data in Electron.
 * Standalone Node.js is unaffected. See: https://github.com/paleolimbot/duckdb-nanoarrow/issues/43
 */
const DEFAULT_PREVIEW_LIMIT = 10_000;

interface ActiveQuery {
  queryId: string;
  sql: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Routes SQL queries from the renderer to the DuckDB worker thread.
 *
 * Manages active query lifecycle including timeouts, cancellation,
 * and query status push events to the renderer.
 */
export class QueryRouter {
  private worker: Worker;
  private mainWindow: BrowserWindow | null = null;
  private activeQueries = new Map<string, ActiveQuery>();
  private shuttingDown = false;

  /**
   * Creates a new QueryRouter attached to a DuckDB worker thread.
   *
   * @param worker - The DuckDB worker thread to dispatch queries to.
   */
  constructor(worker: Worker) {
    this.worker = worker;
  }

  /**
   * Sets the main window reference for pushing query status events.
   *
   * @param win - The main BrowserWindow instance.
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * Replaces the underlying worker thread (e.g., after a restart).
   *
   * @param worker - The new DuckDB worker thread.
   */
  setWorker(worker: Worker): void {
    this.worker = worker;
  }

  /**
   * Dispatches a SQL query to the DuckDB worker thread.
   *
   * Assigns a unique query ID, sets a timeout, and sends an execute_query
   * message to the worker. Pushes an initial "scanning" status to the renderer.
   *
   * @param sql - The SQL statement to execute.
   * @param params - Optional bind parameters for the query.
   * @returns A handle containing the assigned query ID.
   * @throws {@link DatspaceError} If the router is shutting down.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async executeQuery(sql: string, params?: unknown[]): Promise<QueryHandle> {
    if (this.shuttingDown) {
      throw shuttingDownError();
    }

    const queryId = randomUUID();
    const timeoutMs = TIMEOUTS.QUERY_DEFAULT;

    const timeout = setTimeout(() => {
      void this.cancelQuery(queryId);
    }, timeoutMs);

    this.activeQueries.set(queryId, {
      queryId,
      sql,
      startedAt: Date.now(),
      timeout,
    });

    this.worker.postMessage({
      type: 'execute_query',
      queryId,
      sql,
      params,
      options: { timeout: timeoutMs },
    });

    this.pushStatus({
      queryId,
      phase: 'scanning',
      batchesStreamed: 0,
      elapsedMs: 0,
    });

    return { queryId };
  }

  /**
   * Cancels an active query by ID.
   *
   * Clears the timeout, removes the query from tracking, and sends a
   * cancel_query message to the worker.
   *
   * @param queryId - The unique identifier of the query to cancel.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async cancelQuery(queryId: string): Promise<void> {
    const query = this.activeQueries.get(queryId);
    if (query) {
      clearTimeout(query.timeout);
      this.activeQueries.delete(queryId);
    }
    this.worker.postMessage({ type: 'cancel_query', queryId });
  }

  /**
   * Requests the list of user-visible tables from the DuckDB worker.
   *
   * @returns An array of catalog entries describing each table.
   * @throws {@link Error} If the worker does not respond within the IPC timeout.
   */
  async listTables(): Promise<CatalogEntry[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker.removeListener('message', handler);
        reject(new Error('Timeout waiting for table list'));
      }, TIMEOUTS.IPC_DEFAULT);

      const handler = (msg: { type: string; tables?: CatalogEntry[]; message?: string }): void => {
        if (msg.type === 'table_list') {
          clearTimeout(timeout);
          this.worker.removeListener('message', handler);
          resolve(msg.tables ?? []);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          this.worker.removeListener('message', handler);
          reject(new Error(msg.message ?? 'Worker error'));
        }
      };

      this.worker.on('message', handler);
      this.worker.postMessage({ type: 'list_tables' });
    });
  }

  /**
   * Requests column schema information for a specific table.
   *
   * @param tableName - The name of the table to describe.
   * @returns An array of column schema definitions.
   * @throws {@link Error} If the worker does not respond within the IPC timeout.
   */
  async describeTable(tableName: string): Promise<ColumnSchema[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker.removeListener('message', handler);
        reject(new Error('Timeout waiting for table info'));
      }, TIMEOUTS.IPC_DEFAULT);

      const handler = (msg: {
        type: string;
        tableName?: string;
        columns?: ColumnSchema[];
        message?: string;
      }): void => {
        if (msg.type === 'table_info' && msg.tableName === tableName) {
          clearTimeout(timeout);
          this.worker.removeListener('message', handler);
          resolve(msg.columns ?? []);
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          this.worker.removeListener('message', handler);
          reject(new Error(msg.message ?? 'Worker error'));
        }
      };

      this.worker.on('message', handler);
      this.worker.postMessage({ type: 'get_table_info', tableName });
    });
  }

  /**
   * Executes a SELECT * preview query for a table with a row limit.
   *
   * @param tableName - The name of the table to preview.
   * @param limit - Maximum rows to return. Defaults to {@link DEFAULT_PREVIEW_LIMIT}.
   *   DuckDB's nanoarrow `to_arrow_ipc()` can crash (SIGTRAP) on very large unbounded
   *   result sets due to Arrow batch allocation sizing. A default limit prevents this
   *   while still being generous enough for most analytical workflows.
   * @returns A query handle for the preview query.
   */
  async previewTable(tableName: string, limit?: number): Promise<PreviewHandle> {
    // I6: Strict identifier validation — reject names with control chars or SQL injection patterns
    if (!/^[\w$.]+$/u.test(tableName)) {
      throw new Error(`Invalid table name: "${tableName}"`);
    }
    const safeTable = tableName.replace(/"/g, '""');
    const effectiveLimit =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? Math.min(limit, DEFAULT_PREVIEW_LIMIT)
        : DEFAULT_PREVIEW_LIMIT;
    const wasClamped =
      limit !== undefined && Number.isFinite(limit) && limit > DEFAULT_PREVIEW_LIMIT;
    const handle = await this.executeQuery(`SELECT * FROM "${safeTable}" LIMIT ${effectiveLimit}`);
    return { ...handle, effectiveLimit, wasClamped };
  }

  /**
   * Marks a query as completed and removes it from active tracking.
   *
   * @param queryId - The unique identifier of the completed query.
   */
  queryCompleted(queryId: string): void {
    const query = this.activeQueries.get(queryId);
    if (query) {
      clearTimeout(query.timeout);
      this.activeQueries.delete(queryId);
    }
  }

  /**
   * Transitions the router to shutdown mode, cancelling all active queries.
   *
   * After this call, new queries will be rejected with a shutting-down error.
   */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const [queryId, query] of this.activeQueries) {
      clearTimeout(query.timeout);
      this.worker.postMessage({ type: 'cancel_query', queryId });
    }
    this.activeQueries.clear();
  }

  private pushStatus(status: QueryStatusEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(PUSH_EVENTS.QUERY_PROGRESS, status);
    }
  }
}
