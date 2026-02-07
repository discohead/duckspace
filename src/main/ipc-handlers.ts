import os from 'node:os';
import { MessageChannel as NodeMessageChannel, type Worker } from 'node:worker_threads';
import { IPC_CHANNELS, PUSH_EVENTS } from '@shared/constants';
import type { AppState } from '@shared/types';
import { app, type BrowserWindow, ipcMain, MessageChannelMain } from 'electron';
import { computeMemoryLimit, getConfig, setConfigValue } from './config';
import type { QueryRouter } from './query-router';
import type { WorkerManager } from './worker-manager';

let queryRouter: QueryRouter | null = null;
let workerManager: WorkerManager | null = null;
let mainWindow: BrowserWindow | null = null;
let shutdownAckResolve: (() => void) | null = null;
let rendererReadyResolve: (() => void) | null = null;

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

  // Bridge: relay data from Worker → Renderer
  workerChannel.port2.on('message', (data: Record<string, unknown>) => {
    if (data['__transferredBuffers'] && Array.isArray(data['__transferredBuffers'])) {
      // Forward with buffer transfer for zero-copy
      electronPort1.postMessage(data);
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
 * Registers all IPC handlers for query, lifecycle, and config channels.
 *
 * Must be called before the BrowserWindow is created so handlers are ready
 * when the renderer starts sending IPC messages.
 */
export function registerIPCHandlers(): void {
  // === Query Channels ===
  ipcMain.handle(
    IPC_CHANNELS.QUERY_EXECUTE,
    async (_event, args: { sql: string; params?: unknown[] }) => {
      if (!queryRouter) throw new Error('QueryRouter not initialized');
      return queryRouter.executeQuery(args.sql, args.params);
    },
  );

  ipcMain.handle(IPC_CHANNELS.QUERY_CANCEL, async (_event, args: { queryId: string }) => {
    if (!queryRouter) throw new Error('QueryRouter not initialized');
    return queryRouter.cancelQuery(args.queryId);
  });

  ipcMain.handle(IPC_CHANNELS.QUERY_LIST_TABLES, async () => {
    if (!queryRouter) throw new Error('QueryRouter not initialized');
    return queryRouter.listTables();
  });

  ipcMain.handle(IPC_CHANNELS.QUERY_DESCRIBE_TABLE, async (_event, args: { tableName: string }) => {
    if (!queryRouter) throw new Error('QueryRouter not initialized');
    return queryRouter.describeTable(args.tableName);
  });

  ipcMain.handle(
    IPC_CHANNELS.CATALOG_PREVIEW,
    async (_event, args: { tableName: string; limit?: number }) => {
      if (!queryRouter) throw new Error('QueryRouter not initialized');
      return queryRouter.previewTable(args.tableName, args.limit);
    },
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
      const sectionObj = { ...config[sectionKey] } as Record<string, unknown>;
      sectionObj[field] = args.value;
      setConfigValue(sectionKey, sectionObj as (typeof config)[typeof sectionKey]);
    }
  });

  // eslint-disable-next-line @typescript-eslint/require-await
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_ALL, async () => {
    return getConfig();
  });
}

/**
 * Returns a promise that resolves when the renderer signals it is ready.
 *
 * @returns A promise that resolves once the renderer sends the lifecycle:ready IPC message.
 */
export function waitForRendererReady(): Promise<void> {
  return new Promise((resolve) => {
    rendererReadyResolve = resolve;
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
