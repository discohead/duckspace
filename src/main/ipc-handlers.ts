import { ipcMain, BrowserWindow, MessageChannelMain } from 'electron';
import { Worker, MessageChannel as NodeMessageChannel } from 'worker_threads';
import { IPC_CHANNELS, PUSH_EVENTS } from '@shared/constants';
import { getConfig, setConfigValue, getConfigValue } from './config';
import type { WorkerManager } from './worker-manager';
import type { QueryRouter } from './query-router';
import type { AppState } from '@shared/types';
import { app } from 'electron';
import os from 'os';
import { computeMemoryLimit } from './config';

let queryRouter: QueryRouter | null = null;
let workerManager: WorkerManager | null = null;
let mainWindow: BrowserWindow | null = null;
let shutdownAckResolve: (() => void) | null = null;
let rendererReadyResolve: (() => void) | null = null;

export function setQueryRouter(router: QueryRouter): void {
  queryRouter = router;
}

export function setWorkerManager(manager: WorkerManager): void {
  workerManager = manager;
}

export function setMainWindowRef(win: BrowserWindow): void {
  mainWindow = win;
}

export function setupDataChannel(win: BrowserWindow, duckdbWorker: Worker): void {
  // Worker side: Node.js MessageChannel (worker_threads compatible)
  const workerChannel = new NodeMessageChannel();
  duckdbWorker.postMessage(
    { type: 'port', channel: 'duckdb-data', port: workerChannel.port1 },
    [workerChannel.port1]
  );

  // Renderer side: Electron MessageChannelMain
  const { port1: electronPort1, port2: electronPort2 } = new MessageChannelMain();
  win.webContents.postMessage(PUSH_EVENTS.PORT, { channel: 'duckdb-data' }, [electronPort2]);

  // Bridge: relay data from Worker → Renderer
  workerChannel.port2.on('message', (data: Record<string, unknown>) => {
    if (data.__transferredBuffers && Array.isArray(data.__transferredBuffers)) {
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

export function registerIPCHandlers(): void {
  // === Query Channels ===
  ipcMain.handle(IPC_CHANNELS.QUERY_EXECUTE, async (_event, args: { sql: string; params?: unknown[] }) => {
    if (!queryRouter) throw new Error('QueryRouter not initialized');
    return queryRouter.executeQuery(args.sql, args.params);
  });

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

  ipcMain.handle(IPC_CHANNELS.CATALOG_PREVIEW, async (_event, args: { tableName: string; limit?: number }) => {
    if (!queryRouter) throw new Error('QueryRouter not initialized');
    return queryRouter.previewTable(args.tableName, args.limit);
  });

  // === Lifecycle Channels ===
  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_READY, async () => {
    if (rendererReadyResolve) {
      rendererReadyResolve();
      rendererReadyResolve = null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_GET_APP_STATE, async (): Promise<AppState> => {
    const config = getConfig();
    const totalSystemMB = Math.round(os.totalmem() / (1024 * 1024));
    const freeSystemMB = Math.round(os.freemem() / (1024 * 1024));
    const duckdbLimitStr = computeMemoryLimit();
    const duckdbLimitMB = parseInt(duckdbLimitStr.replace('MB', ''), 10);

    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      memory: {
        totalSystemMB,
        freeSystemMB,
        duckdbLimitMB,
      },
      workers: {
        duckdb: (workerManager?.getStatus() as AppState['workers']['duckdb']) ?? 'failed',
      },
      shutdownStatus: 'dirty', // Will be overridden by Renderer reading Dexie.js
    };
  });

  ipcMain.handle(IPC_CHANNELS.LIFECYCLE_SHUTDOWN_ACK, async () => {
    if (shutdownAckResolve) {
      shutdownAckResolve();
      shutdownAckResolve = null;
    }
  });

  // === Config Channels ===
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async (_event, args: { key: string }) => {
    const config = getConfig();
    const keys = args.key.split('.');
    let value: unknown = config;
    for (const k of keys) {
      value = (value as Record<string, unknown>)?.[k];
    }
    return value;
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, async (_event, args: { key: string; value: unknown }) => {
    const config = getConfig();
    const keys = args.key.split('.');
    if (keys.length === 2) {
      const section = keys[0] as keyof typeof config;
      const field = keys[1];
      const sectionObj = { ...config[section] } as Record<string, unknown>;
      sectionObj[field] = args.value;
      setConfigValue(section, sectionObj as typeof config[typeof section]);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_ALL, async () => {
    return getConfig();
  });
}

export function waitForRendererReady(): Promise<void> {
  return new Promise((resolve) => {
    rendererReadyResolve = resolve;
  });
}

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

export function sendShutdownPrepare(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH_EVENTS.SHUTDOWN_PREPARE);
  }
}
