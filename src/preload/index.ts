/**
 * Electron preload script that sets up the `window.duckspace` bridge.
 *
 * Runs in the Renderer's isolated preload context. Uses `contextBridge.exposeInMainWorld`
 * to expose a safe API surface to the Renderer without granting full Node.js access.
 * Handles MessagePort receipt for the Arrow IPC data plane and wires up IPC
 * listeners for push events (query progress, worker health, shutdown).
 *
 * @module preload
 */

import { IPC_CHANNELS, PUSH_EVENTS } from '@shared/constants';
import type {
  AddWatchDirectoryRequest,
  ArrowBatch,
  ArrowBatchMessage,
  CancelJobResponse,
  CatalogSourceUpdatedEvent,
  DataPlaneError,
  DataSource,
  GetColumnStatsResponse,
  GetProgressResponse,
  GetSourcesRequest,
  ImportFilesResponse,
  IngestionCompleteEvent,
  IngestionProgressEvent,
  IngestionTrigger,
  QueryHistoryPushRecord,
  QueryStatus,
  RemoveSourceResponse,
  RemoveWatchDirectoryResponse,
  StreamEndMessage,
  UpdateSourceRequest,
  WatchDirectory,
  WatchFileEvent,
  WorkerHealth,
} from '@shared/types';
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { DuckspaceAPI } from './api';

/** Inbound data plane message with buffer attached by the MessagePort */
type InboundDataPlaneMessage =
  | (ArrowBatchMessage & { buffer?: ArrayBuffer })
  | StreamEndMessage
  | DataPlaneError;

// MessagePort storage — extract the port type from Electron's IpcRendererEvent
// since the DOM lib is not included in tsconfig
type ElectronMessagePort = IpcRendererEvent['ports'][number];
const ports = new Map<string, ElectronMessagePort>();
const dataCallbacks = new Map<string, Set<(batch: ArrowBatch) => void>>();

/**
 * Buffer for Arrow batches that arrive before any subscriber registers via `onData`.
 * Prevents data loss when fast queries complete between `execute()` IPC response
 * and the React `useEffect` that subscribes to `onData`. Capped at 100 batches per
 * query to bound memory usage.
 */
const MAX_PENDING_BATCHES = 100;
/** Timeout (ms) before unclaimed pendingBatches entries are cleaned up after terminal events. */
const PENDING_BATCH_CLEANUP_MS = 30_000;
const pendingBatches = new Map<string, ArrowBatch[]>();

// Receive MessagePorts from Main Process
ipcRenderer.on(PUSH_EVENTS.PORT, (event: IpcRendererEvent, payload: { channel: string }) => {
  const [port] = event.ports;
  if (!port) return;

  ports.set(payload.channel, port);

  if (payload.channel === 'duckdb-data') {
    port.onmessage = (msgEvent: MessageEvent) => {
      const msg = msgEvent.data as InboundDataPlaneMessage;

      if (msg.type === 'arrow-batch') {
        const arrowBuffer =
          'buffer' in msg && msg.buffer instanceof ArrayBuffer ? msg.buffer : new ArrayBuffer(0);

        const batch: ArrowBatch = {
          buffer: arrowBuffer,
          index: msg.index,
          rowCount: msg.rowCount,
          byteSize: msg.byteSize,
          isLast: false,
        };

        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          for (const cb of callbacks) cb(batch);
        } else {
          // Buffer early batches until a subscriber registers via onData
          let buf = pendingBatches.get(msg.queryId);
          if (!buf) {
            buf = [];
            pendingBatches.set(msg.queryId, buf);
          }
          if (buf.length < MAX_PENDING_BATCHES) {
            buf.push(batch);
          }
        }
        // ACK unconditionally to prevent backpressure deadlock
        port.postMessage({ type: 'ack', queryId: msg.queryId, index: msg.index });
      } else if (msg.type === 'arrow-end') {
        const batch: ArrowBatch = {
          buffer: new ArrayBuffer(0),
          index: msg.totalBatches,
          rowCount: msg.totalRows,
          byteSize: msg.totalBytes,
          isLast: true,
          statusMessage: msg.statusMessage,
        };

        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          for (const cb of callbacks) cb(batch);
        } else {
          let buf = pendingBatches.get(msg.queryId);
          if (!buf) {
            buf = [];
            pendingBatches.set(msg.queryId, buf);
          }
          buf.push(batch);
          // Schedule cleanup if no subscriber claims the buffered data
          setTimeout(() => {
            if (!dataCallbacks.has(msg.queryId)) {
              pendingBatches.delete(msg.queryId);
            }
          }, PENDING_BATCH_CLEANUP_MS);
        }
      } else {
        // msg.type === 'arrow-error'
        const batch: ArrowBatch = {
          buffer: new ArrayBuffer(0),
          index: 0,
          rowCount: 0,
          byteSize: 0,
          isLast: true,
          error: { code: msg.code, message: msg.message },
        };

        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          for (const cb of callbacks) cb(batch);
        } else {
          let buf = pendingBatches.get(msg.queryId);
          if (!buf) {
            buf = [];
            pendingBatches.set(msg.queryId, buf);
          }
          buf.push(batch);
          // Schedule cleanup if no subscriber claims the buffered data
          setTimeout(() => {
            if (!dataCallbacks.has(msg.queryId)) {
              pendingBatches.delete(msg.queryId);
            }
          }, PENDING_BATCH_CLEANUP_MS);
        }
      }
    };
    port.start();
  }
});

const api: DuckspaceAPI = {
  query: {
    execute: (sql: string, params?: unknown[]) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY_EXECUTE, { sql, params }),

    cancel: (queryId: string) => ipcRenderer.invoke(IPC_CHANNELS.QUERY_CANCEL, { queryId }),

    onStatus: (callback: (status: QueryStatus) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: QueryStatus): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.QUERY_PROGRESS, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.QUERY_PROGRESS, handler);
    },

    onData: (queryId: string, callback: (batch: ArrowBatch) => void) => {
      if (!dataCallbacks.has(queryId)) {
        dataCallbacks.set(queryId, new Set());
      }
      dataCallbacks.get(queryId)?.add(callback);

      // Flush any batches that arrived before this subscriber registered
      const buffered = pendingBatches.get(queryId);
      if (buffered) {
        pendingBatches.delete(queryId);
        for (const batch of buffered) callback(batch);
      }

      return () => {
        const set = dataCallbacks.get(queryId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) {
            dataCallbacks.delete(queryId);
            pendingBatches.delete(queryId);
          }
        }
      };
    },

    onQueryHistory: (callback: (record: QueryHistoryPushRecord) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: QueryHistoryPushRecord): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.QUERY_HISTORY, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.QUERY_HISTORY, handler);
    },
  },

  catalog: {
    listTables: () => ipcRenderer.invoke(IPC_CHANNELS.QUERY_LIST_TABLES),

    describeTable: (tableName: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUERY_DESCRIBE_TABLE, { tableName }),

    previewTable: (tableName: string, limit?: number) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_PREVIEW, { tableName, limit }),

    getSources: (filters?: GetSourcesRequest['filters']): Promise<DataSource[]> =>
      ipcRenderer
        .invoke(IPC_CHANNELS.CATALOG_GET_SOURCES, { type: 'catalog:getSources', filters })
        .then((r: { sources: DataSource[] }) => r.sources),

    removeSource: (dataSourceId: string): Promise<RemoveSourceResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_REMOVE_SOURCE, {
        type: 'catalog:removeSource',
        dataSourceId,
      }),

    updateSource: (
      dataSourceId: string,
      updates: UpdateSourceRequest['updates'],
    ): Promise<DataSource> =>
      ipcRenderer
        .invoke(IPC_CHANNELS.CATALOG_UPDATE_SOURCE, {
          type: 'catalog:updateSource',
          dataSourceId,
          updates,
        })
        .then((r: { source: DataSource }) => r.source),

    getColumnStats: (
      dataSourceId: string,
      forceRecompute?: boolean,
      tableName?: string,
    ): Promise<GetColumnStatsResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_GET_COLUMN_STATS, {
        type: 'catalog:getColumnStats',
        dataSourceId,
        tableName,
        forceRecompute,
      }),

    onSourceUpdated: (callback: (event: CatalogSourceUpdatedEvent) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: CatalogSourceUpdatedEvent): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.CATALOG_SOURCE_UPDATED, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.CATALOG_SOURCE_UPDATED, handler);
    },
  },

  ingestion: {
    importFiles: (
      filePaths: readonly string[],
      trigger: IngestionTrigger,
      dataSourceId?: string,
    ): Promise<ImportFilesResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.INGESTION_IMPORT_FILES, {
        type: 'ingestion:importFiles',
        filePaths,
        trigger,
        dataSourceId,
      }),

    cancelJob: (jobId: string): Promise<CancelJobResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.INGESTION_CANCEL_JOB, {
        type: 'ingestion:cancelJob',
        jobId,
      }),

    getProgress: (jobId: string): Promise<GetProgressResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.INGESTION_GET_PROGRESS, {
        type: 'ingestion:getProgress',
        jobId,
      }),

    onProgress: (callback: (event: IngestionProgressEvent) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: IngestionProgressEvent): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.INGESTION_PROGRESS, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.INGESTION_PROGRESS, handler);
    },

    onComplete: (callback: (event: IngestionCompleteEvent) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: IngestionCompleteEvent): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.INGESTION_COMPLETE, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.INGESTION_COMPLETE, handler);
    },
  },

  watch: {
    addDirectory: (
      path: string,
      options?: AddWatchDirectoryRequest['options'],
    ): Promise<WatchDirectory> =>
      ipcRenderer
        .invoke(IPC_CHANNELS.WATCH_ADD_DIRECTORY, {
          type: 'watch:addDirectory',
          path,
          options,
        })
        .then((r: { watchDirectory: WatchDirectory }) => r.watchDirectory),

    removeDirectory: (
      watchDirectoryId: string,
      removeAssociatedSources?: boolean,
    ): Promise<RemoveWatchDirectoryResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.WATCH_REMOVE_DIRECTORY, {
        type: 'watch:removeDirectory',
        watchDirectoryId,
        removeAssociatedSources,
      }),

    listDirectories: (): Promise<WatchDirectory[]> =>
      ipcRenderer
        .invoke(IPC_CHANNELS.WATCH_LIST_DIRECTORIES)
        .then((r: { directories: WatchDirectory[] }) => r.directories),

    restoreDirectories: (directories: readonly WatchDirectory[]): Promise<number> =>
      ipcRenderer
        .invoke(IPC_CHANNELS.WATCH_RESTORE_DIRECTORIES, {
          type: 'watch:restoreDirectories',
          directories,
        })
        .then((r: { restored: number }) => r.restored),

    onFileEvent: (callback: (event: WatchFileEvent) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: WatchFileEvent): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.WATCH_FILE_EVENT, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.WATCH_FILE_EVENT, handler);
    },
  },

  lifecycle: {
    ready: () => ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_READY),

    getAppState: () => ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_GET_APP_STATE),

    shutdownAck: () => ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_SHUTDOWN_ACK),

    onWorkerHealth: (callback: (health: WorkerHealth) => void): (() => void) => {
      const handler = (_: IpcRendererEvent, data: WorkerHealth): void => {
        callback(data);
      };
      ipcRenderer.on(PUSH_EVENTS.WORKER_STATUS, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.WORKER_STATUS, handler);
    },

    onShutdownPrepare: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(PUSH_EVENTS.SHUTDOWN_PREPARE, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.SHUTDOWN_PREPARE, handler);
    },

    onBoundsChanged: (
      callback: (bounds: { x: number; y: number; width: number; height: number }) => void,
    ): (() => void) => {
      const handler = (
        _: IpcRendererEvent,
        bounds: { x: number; y: number; width: number; height: number },
      ): void => {
        callback(bounds);
      };
      ipcRenderer.on(PUSH_EVENTS.WINDOW_BOUNDS_CHANGED, handler);
      return () => ipcRenderer.removeListener(PUSH_EVENTS.WINDOW_BOUNDS_CHANGED, handler);
    },
  },
};

contextBridge.exposeInMainWorld('duckspace', api);
