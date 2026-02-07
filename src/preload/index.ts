/**
 * Electron preload script that sets up the `window.datspace` bridge.
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
  ArrowBatch,
  ArrowBatchMessage,
  DataPlaneError,
  QueryHistoryPushRecord,
  QueryStatus,
  StreamEndMessage,
  WorkerHealth,
} from '@shared/types';
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { DatspaceAPI } from './api';

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

// Receive MessagePorts from Main Process
ipcRenderer.on(PUSH_EVENTS.PORT, (event: IpcRendererEvent, payload: { channel: string }) => {
  const [port] = event.ports;
  if (!port) return;

  ports.set(payload.channel, port);

  if (payload.channel === 'duckdb-data') {
    port.onmessage = (msgEvent: MessageEvent) => {
      const msg = msgEvent.data as InboundDataPlaneMessage;

      if (msg.type === 'arrow-batch') {
        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          // The ArrayBuffer is transferred alongside the message via the buffer property
          const arrowBuffer =
            'buffer' in msg && msg.buffer instanceof ArrayBuffer ? msg.buffer : new ArrayBuffer(0);

          const batch: ArrowBatch = {
            buffer: arrowBuffer,
            index: msg.index,
            rowCount: msg.rowCount,
            byteSize: msg.byteSize,
            isLast: false,
          };
          for (const cb of callbacks) cb(batch);
        }
        // ACK unconditionally to prevent backpressure deadlock
        port.postMessage({ type: 'ack', queryId: msg.queryId, index: msg.index });
      } else if (msg.type === 'arrow-end') {
        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          const batch: ArrowBatch = {
            buffer: new ArrayBuffer(0),
            index: msg.totalBatches,
            rowCount: msg.totalRows,
            byteSize: msg.totalBytes,
            isLast: true,
          };
          for (const cb of callbacks) cb(batch);
        }
      } else {
        // msg.type === 'arrow-error'
        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          const errorMsg = msg as DataPlaneError;
          const batch: ArrowBatch = {
            buffer: new ArrayBuffer(0),
            index: 0,
            rowCount: 0,
            byteSize: 0,
            isLast: true,
            error: { code: errorMsg.code, message: errorMsg.message },
          };
          for (const cb of callbacks) cb(batch);
        }
      }
    };
    port.start();
  }
});

const api: DatspaceAPI = {
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
      return () => {
        const set = dataCallbacks.get(queryId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) dataCallbacks.delete(queryId);
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
      ipcRenderer.invoke(IPC_CHANNELS.CATALOG_PREVIEW, { tableName, limit: limit ?? 100 }),
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

contextBridge.exposeInMainWorld('datspace', api);
