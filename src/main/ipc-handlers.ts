import os from 'node:os';
import { MessageChannel as NodeMessageChannel, type Worker } from 'node:worker_threads';
import { IPC_CHANNELS, PUSH_EVENTS, TIMEOUTS } from '@shared/constants';
import { DatspaceConfigSchema } from '@shared/schemas/config-schema';
import type { AppState } from '@shared/types';
import { app, type BrowserWindow, dialog, ipcMain, MessageChannelMain } from 'electron';
import { computeMemoryLimit, getConfig, setConfigValue } from './config';
import type { QueryRouter } from './query-router';
import type { WorkerManager } from './worker-manager';

let queryRouter: QueryRouter | null = null;
let workerManager: WorkerManager | null = null;
let mainWindow: BrowserWindow | null = null;
let shutdownAckResolve: (() => void) | null = null;
let rendererReadyResolve: (() => void) | null = null;
let handlersRegistered = false;
let ingestionRouterReady = false;

/**
 * Sets the QueryRouter reference used by IPC handlers.
 *
 * @param router - The QueryRouter instance to use for query dispatch.
 */
export function setQueryRouter(router: QueryRouter): void {
  queryRouter = router;
}

/**
 * Sets the WorkerManager reference used by IPC handlers.
 *
 * @param manager - The WorkerManager instance to query for worker status.
 */
export function setWorkerManager(manager: WorkerManager): void {
  workerManager = manager;
}

/**
 * Signals that the ingestion router is initialized and ready for IPC requests.
 */
export function setIngestionReady(): void {
  ingestionRouterReady = true;
}

/**
 * Sets the main BrowserWindow reference for shutdown notifications.
 *
 * @param win - The main application window.
 */
export function setMainWindowRef(win: BrowserWindow): void {
  mainWindow = win;
}

/**
 * Establishes the MessagePort data channel between the DuckDB worker and the renderer.
 *
 * Creates a Node.js MessageChannel for the worker side and an Electron MessageChannelMain
 * for the renderer side, then bridges them to relay Arrow IPC buffers and ACK messages.
 *
 * @param win - The main BrowserWindow to connect to the renderer.
 * @param duckdbWorker - The DuckDB worker thread to connect to.
 */
export function setupDataChannel(win: BrowserWindow, duckdbWorker: Worker): void {
  // Worker side: Node.js MessageChannel (worker_threads compatible)
  const workerChannel = new NodeMessageChannel();
  duckdbWorker.postMessage({ type: 'port', channel: 'duckdb-data', port: workerChannel.port1 }, [
    workerChannel.port1,
  ]);

  // Renderer side: Electron MessageChannelMain
  const { port1: electronPort1, port2: electronPort2 } = new MessageChannelMain();
  win.webContents.postMessage(PUSH_EVENTS.PORT, { channel: 'duckdb-data' }, [electronPort2]);

  // Bridge: relay data from Worker → Renderer.
  // Two constraints:
  //   1. Electron's MessagePortMain.postMessage does NOT support ArrayBuffer
  //      in its transfer list (only MessagePortMain[]).
  //   2. ArrayBuffers received via Node.js worker_threads transfer are not
  //      properly structured-cloned across the Electron process boundary
  //      (they arrive as 0-byte buffers in the renderer).
  // Fix: explicitly copy the ArrayBuffer in the Main process so Electron's
  // structured clone operates on a fresh, Main-context-owned buffer.
  workerChannel.port2.on('message', (data: Record<string, unknown>) => {
    const buf = data['buffer'];
    if (buf instanceof ArrayBuffer && buf.byteLength > 0) {
      const copy = new ArrayBuffer(buf.byteLength);
      new Uint8Array(copy).set(new Uint8Array(buf));
      electronPort1.postMessage({ ...data, buffer: copy });
    } else {
      electronPort1.postMessage(data);
    }
  });

  // Bridge: relay ACKs from Renderer → Worker (for backpressure)
  electronPort1.on('message', (event) => {
    workerChannel.port2.postMessage(event.data);
  });

  electronPort1.start();
}

/**
 * Wraps an IPC handler with error boundary that logs and re-throws.
 * Ensures unhandled errors in handlers are visible in logs rather than silently lost.
 *
 * @param channel - The IPC channel name (for log context).
 * @param handler - The async handler function to wrap.
 * @returns The wrapped handler.
 */
function wrapIPCHandler<T extends unknown[], R>(
  channel: string,
  handler: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`IPC handler error [${channel}]:`, err);
      throw err;
    }
  };
}

/**
 * Registers all IPC handlers for query, lifecycle, and config channels.
 *
 * Must be called before the BrowserWindow is created so handlers are ready
 * when the renderer starts sending IPC messages.
 */
export function registerIPCHandlers(): void {
  if (handlersRegistered) return;

  // === Query Channels ===
  ipcMain.handle(
    IPC_CHANNELS.QUERY_EXECUTE,
    wrapIPCHandler(
      IPC_CHANNELS.QUERY_EXECUTE,
      async (_event: unknown, args: { sql: string; params?: unknown[] }) => {
        if (!queryRouter) throw new Error('QueryRouter not initialized');
        return queryRouter.executeQuery(args.sql, args.params);
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.QUERY_CANCEL,
    wrapIPCHandler(
      IPC_CHANNELS.QUERY_CANCEL,
      async (_event: unknown, args: { queryId: string }) => {
        if (!queryRouter) throw new Error('QueryRouter not initialized');
        return queryRouter.cancelQuery(args.queryId);
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.QUERY_LIST_TABLES,
    wrapIPCHandler(IPC_CHANNELS.QUERY_LIST_TABLES, async () => {
      if (!queryRouter) throw new Error('QueryRouter not initialized');
      return queryRouter.listTables();
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.QUERY_DESCRIBE_TABLE,
    wrapIPCHandler(
      IPC_CHANNELS.QUERY_DESCRIBE_TABLE,
      async (_event: unknown, args: { tableName: string }) => {
        if (!queryRouter) throw new Error('QueryRouter not initialized');
        return queryRouter.describeTable(args.tableName);
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.CATALOG_PREVIEW,
    wrapIPCHandler(
      IPC_CHANNELS.CATALOG_PREVIEW,
      async (_event: unknown, args: { tableName: string; limit?: number }) => {
        if (!queryRouter) throw new Error('QueryRouter not initialized');
        return queryRouter.previewTable(args.tableName, args.limit);
      },
    ),
  );

  // === Lifecycle Channels ===
  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_READY, async () => {
    if (rendererReadyResolve) {
      rendererReadyResolve();
      rendererReadyResolve = null;
    }
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_GET_APP_STATE, async (): Promise<AppState> => {
    const totalSystemMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeSystemMb = Math.round(os.freemem() / (1024 * 1024));
    const duckdbLimitStr = computeMemoryLimit();
    const duckdbLimitMb = parseInt(duckdbLimitStr.replace('MB', ''), 10);

    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      memory: {
        totalSystemMB: totalSystemMb,
        freeSystemMB: freeSystemMb,
        duckdbLimitMB: duckdbLimitMb,
      },
      workers: {
        duckdb: (workerManager?.getStatus() ?? 'failed') as AppState['workers']['duckdb'],
      },
      shutdownStatus: 'dirty', // Will be overridden by Renderer reading Dexie.js
    };
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_SHUTDOWN_ACK, async () => {
    if (shutdownAckResolve) {
      shutdownAckResolve();
      shutdownAckResolve = null;
    }
  });

  // === Config Channels ===
  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async (_event, args: { key: string }) => {
    const config = getConfig();
    const keys = args.key.split('.');
    let value: unknown = config;
    for (const k of keys) {
      if (value === null || value === undefined || typeof value !== 'object') {
        return undefined;
      }
      value = (value as Record<string, unknown>)[k];
    }
    return value;
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, async (_event, args: { key: string; value: unknown }) => {
    const config = getConfig();
    const keys = args.key.split('.');
    const section = keys[0];
    const field = keys[1];
    if (keys.length === 2 && section !== undefined && field !== undefined) {
      const sectionKey = section as keyof typeof config;
      if (!(sectionKey in config)) return;
      const sectionObj = { ...config[sectionKey] } as Record<string, unknown>;
      sectionObj[field] = args.value;

      // Validate the proposed section against the Zod schema
      const proposed = { ...config, [sectionKey]: sectionObj };
      const result = DatspaceConfigSchema.safeParse(proposed);
      if (!result.success) {
        console.warn(`config:set rejected [${args.key}]:`, result.error.issues);
        return;
      }

      setConfigValue(sectionKey, result.data[sectionKey]);
    }
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_ALL, async () => {
    return getConfig();
  });

  // === Ingestion Channels ===
  ipcMain.handle(
    IPC_CHANNELS.INGESTION_IMPORT_FILES,
    wrapIPCHandler(
      IPC_CHANNELS.INGESTION_IMPORT_FILES,
      async (_event: unknown, args: { filePaths: readonly string[]; trigger: string }) => {
        if (!ingestionRouterReady) throw new Error('Ingestion router not initialized');
        // Lazy import to avoid circular dependency
        const { importFiles } = await import('./ingestion/ingestion-router');

        let filePaths = [...args.filePaths];

        // If no paths provided, show native file dialog (file_picker trigger)
        if (filePaths.length === 0) {
          const result = await dialog.showOpenDialog({
            properties: ['openFile', 'multiSelections'],
            filters: [
              {
                name: 'Data Files',
                extensions: [
                  'csv',
                  'tsv',
                  'parquet',
                  'json',
                  'jsonl',
                  'ndjson',
                  'xlsx',
                  'xls',
                  'arrow',
                  'ipc',
                  'feather',
                ],
              },
            ],
          });
          if (result.canceled || result.filePaths.length === 0) {
            return { jobs: [] };
          }
          filePaths = result.filePaths;
        }

        return importFiles(
          filePaths,
          args.trigger as 'file_picker' | 'drag_and_drop' | 'watch_directory' | 'retry',
        );
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.INGESTION_CANCEL_JOB,
    wrapIPCHandler(
      IPC_CHANNELS.INGESTION_CANCEL_JOB,
      // eslint-disable-next-line @typescript-eslint/require-await
      async (_event: unknown, args: { jobId: string }) => {
        const { cancelJob } = await import('./ingestion/ingestion-router');
        const cancelled = cancelJob(args.jobId);
        return { jobId: args.jobId, cancelled };
      },
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.INGESTION_GET_PROGRESS,
    wrapIPCHandler(
      IPC_CHANNELS.INGESTION_GET_PROGRESS,
      // eslint-disable-next-line @typescript-eslint/require-await
      async (_event: unknown, args: { jobId: string }) => {
        const { getProgressTracker } = await import('./ingestion/ingestion-router');
        const tracker = getProgressTracker();
        const state = tracker.getJobState(args.jobId);
        if (!state) {
          return { jobId: args.jobId, status: 'not_found' };
        }
        const estimate = tracker.estimateCompletion(args.jobId);
        return {
          jobId: args.jobId,
          status: state.status,
          rowsProcessed: state.rowsProcessed,
          bytesProcessed: state.bytesProcessed,
          percentage: estimate?.percentage,
          estimatedTotalRows: estimate?.estimatedTotalRows,
          elapsedMs: estimate?.elapsedMs,
        };
      },
    ),
  );

  // === Catalog Extended Channels ===
  // Placeholder handlers for Phase 5-7 features (getSources, removeSource, updateSource, getColumnStats)
  // These will be fully implemented when their respective user stories are built.
  // For now, register them to prevent "No handler registered" errors.

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CATALOG_GET_SOURCES, async () => {
    return { sources: [] };
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CATALOG_REMOVE_SOURCE, async () => {
    return { success: false, message: 'Not yet implemented' };
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CATALOG_UPDATE_SOURCE, async () => {
    return { success: false, message: 'Not yet implemented' };
  });

  ipcMain.handle(
    IPC_CHANNELS.CATALOG_GET_COLUMN_STATS,
    wrapIPCHandler(
      IPC_CHANNELS.CATALOG_GET_COLUMN_STATS,
      async (
        _event: unknown,
        args: { dataSourceId: string; tableName?: string; forceRecompute?: boolean },
      ) => {
        const { getTableNameForSource, computeStats, registerDataSourceTable } = await import(
          './ingestion/ingestion-router'
        );

        // Resolve tableName: first check the in-memory map, then fall back to
        // a tableName provided by the renderer (for restart recovery).
        let tableName = getTableNameForSource(args.dataSourceId);
        if (!tableName && args.tableName) {
          tableName = args.tableName;
          registerDataSourceTable(args.dataSourceId, tableName);
        }
        if (!tableName) {
          throw new Error(`No table name found for data source: ${args.dataSourceId}`);
        }

        const startMs = Date.now();
        const result = await computeStats(tableName);

        const columns = result.columns.map((col) => ({
          id: `${args.dataSourceId}__${col.columnName}`,
          dataSourceId: args.dataSourceId,
          columnName: col.columnName,
          columnType: col.columnType,
          rowCount: col.rowCount,
          nullCount: col.nullCount,
          nullPercentage: col.nullPercentage,
          distinctCount: col.distinctCount,
          min: col.min,
          max: col.max,
          mean: col.mean,
          median: col.median,
          stddev: col.stddev,
          q25: col.q25,
          q75: col.q75,
          topValues: col.topValues?.map((tv) => ({
            value: tv.value,
            count: tv.count,
            percentage: col.rowCount > 0 ? (tv.count / col.rowCount) * 100 : 0,
          })),
          computedAt: new Date().toISOString(),
        }));

        return {
          type: 'catalog:getColumnStats:response' as const,
          dataSourceId: args.dataSourceId,
          columns,
          computedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
        };
      },
    ),
  );

  // === Watch Channels (placeholders for US4) ===

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.WATCH_ADD_DIRECTORY, async () => {
    return { success: false, message: 'Not yet implemented' };
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.WATCH_REMOVE_DIRECTORY, async () => {
    return { success: false, message: 'Not yet implemented' };
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.WATCH_LIST_DIRECTORIES, async () => {
    return { directories: [] };
  });

  handlersRegistered = true;
}

/**
 * Returns a promise that resolves when the renderer signals it is ready,
 * or rejects after TIMEOUTS.RENDERER_READY ms.
 *
 * @param timeoutMs - Override the default timeout (for testing).
 * @returns A promise that resolves once the renderer sends the lifecycle:ready IPC message.
 * @throws {@link Error} If the renderer does not signal ready within the timeout.
 */
export function waitForRendererReady(timeoutMs?: number): Promise<void> {
  const ms = timeoutMs ?? TIMEOUTS.RENDERER_READY;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      rendererReadyResolve = null;
      reject(new Error(`Renderer did not signal ready within ${ms}ms`));
    }, ms);

    rendererReadyResolve = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

/**
 * Waits for the renderer to acknowledge shutdown, with a timeout.
 *
 * @param timeoutMs - Maximum time in milliseconds to wait for the acknowledgment.
 * @returns True if acknowledged before timeout, false if timed out.
 */
export function waitForShutdownAck(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      shutdownAckResolve = null;
      resolve(false);
    }, timeoutMs);

    shutdownAckResolve = () => {
      clearTimeout(timeout);
      resolve(true);
    };
  });
}

/**
 * Sends the shutdown-prepare push event to the renderer.
 *
 * No-op if the main window is null or destroyed.
 */
export function sendShutdownPrepare(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH_EVENTS.SHUTDOWN_PREPARE);
  }
}
