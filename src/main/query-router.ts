import { randomUUID } from 'crypto';
import type { Worker } from 'worker_threads';
import type { BrowserWindow } from 'electron';
import type {
  QueryHandle,
  CatalogEntry,
  ColumnSchema,
  QueryStatusEvent,
} from '@shared/types';
import { PUSH_EVENTS, TIMEOUTS } from '@shared/constants';
import { shuttingDownError } from '@shared/errors';

interface ActiveQuery {
  queryId: string;
  sql: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

export class QueryRouter {
  private worker: Worker;
  private mainWindow: BrowserWindow | null = null;
  private activeQueries = new Map<string, ActiveQuery>();
  private shuttingDown = false;

  constructor(worker: Worker) {
    this.worker = worker;
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setWorker(worker: Worker): void {
    this.worker = worker;
  }

  async executeQuery(sql: string, params?: unknown[]): Promise<QueryHandle> {
    if (this.shuttingDown) {
      throw shuttingDownError().toIPCError();
    }

    const queryId = randomUUID();
    const timeoutMs = TIMEOUTS.QUERY_DEFAULT;

    const timeout = setTimeout(() => {
      this.cancelQuery(queryId);
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

  async cancelQuery(queryId: string): Promise<void> {
    const query = this.activeQueries.get(queryId);
    if (query) {
      clearTimeout(query.timeout);
      this.activeQueries.delete(queryId);
    }
    this.worker.postMessage({ type: 'cancel_query', queryId });
  }

  async listTables(): Promise<CatalogEntry[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker.removeListener('message', handler);
        reject(new Error('Timeout waiting for table list'));
      }, TIMEOUTS.IPC_DEFAULT);

      const handler = (msg: { type: string; tables?: CatalogEntry[]; message?: string }) => {
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

  async describeTable(tableName: string): Promise<ColumnSchema[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.worker.removeListener('message', handler);
        reject(new Error('Timeout waiting for table info'));
      }, TIMEOUTS.IPC_DEFAULT);

      const handler = (msg: { type: string; tableName?: string; columns?: ColumnSchema[]; message?: string }) => {
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

  async previewTable(tableName: string, limit?: number): Promise<QueryHandle> {
    const previewLimit = limit ?? 100;
    return this.executeQuery(`SELECT * FROM "${tableName}" LIMIT ${previewLimit}`);
  }

  queryCompleted(queryId: string): void {
    const query = this.activeQueries.get(queryId);
    if (query) {
      clearTimeout(query.timeout);
      this.activeQueries.delete(queryId);
    }
  }

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
