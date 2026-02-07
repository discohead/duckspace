import { IPC_CHANNELS, PUSH_EVENTS } from '@shared/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock electron module
//
// vi.mock hoists to the top of the file. After vi.resetModules(), the
// factory re-runs for each fresh import, producing new vi.fn() instances.
// We must retrieve the mock via `await import('electron')` after loading
// the preload module so we get the SAME instance the preload code uses.
// --------------------------------------------------------------------------
const handlers = new Map<string, Function>();

vi.mock('electron', () => {
  const h = handlers;
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((channel: string, handler: Function) => {
        h.set(channel, handler);
      }),
      removeListener: vi.fn(),
    },
  };
});

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Load preload and return the mocked electron module (same instance) */
async function loadPreload() {
  await import('@preload/index');
  const electron = await import('electron');
  return electron;
}

function getExposedApi(electron: any) {
  const call = (electron.contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock.calls[0];
  return { name: call[0] as string, api: call[1] };
}

function createMockMessagePort(): any {
  return {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    start: vi.fn(),
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('preload/index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    vi.resetModules();
  });

  // ========================================================================
  // contextBridge.exposeInMainWorld
  // ========================================================================

  describe('contextBridge setup', () => {
    it('calls exposeInMainWorld with "datspace" and correct API shape', async () => {
      const electron = await loadPreload();

      expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledOnce();
      expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
        'datspace',
        expect.objectContaining({
          query: expect.any(Object),
          catalog: expect.any(Object),
          lifecycle: expect.any(Object),
        }),
      );
    });

    it('exposes query namespace with all methods', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      expect(api.query).toBeDefined();
      expect(api.query.execute).toBeTypeOf('function');
      expect(api.query.cancel).toBeTypeOf('function');
      expect(api.query.onStatus).toBeTypeOf('function');
      expect(api.query.onData).toBeTypeOf('function');
      expect(api.query.onQueryHistory).toBeTypeOf('function');
    });

    it('exposes catalog namespace with all methods', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      expect(api.catalog).toBeDefined();
      expect(api.catalog.listTables).toBeTypeOf('function');
      expect(api.catalog.describeTable).toBeTypeOf('function');
      expect(api.catalog.previewTable).toBeTypeOf('function');
    });

    it('exposes lifecycle namespace with all methods', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      expect(api.lifecycle).toBeDefined();
      expect(api.lifecycle.ready).toBeTypeOf('function');
      expect(api.lifecycle.getAppState).toBeTypeOf('function');
      expect(api.lifecycle.shutdownAck).toBeTypeOf('function');
      expect(api.lifecycle.onWorkerHealth).toBeTypeOf('function');
      expect(api.lifecycle.onShutdownPrepare).toBeTypeOf('function');
      expect(api.lifecycle.onBoundsChanged).toBeTypeOf('function');
    });
  });

  // ========================================================================
  // query namespace
  // ========================================================================

  describe('query.execute', () => {
    it('calls ipcRenderer.invoke with QUERY_EXECUTE channel and payload', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.query.execute('SELECT 1', [42]);

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.QUERY_EXECUTE, {
        sql: 'SELECT 1',
        params: [42],
      });
    });

    it('passes undefined params when not provided', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.query.execute('SELECT 1');

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.QUERY_EXECUTE, {
        sql: 'SELECT 1',
        params: undefined,
      });
    });
  });

  describe('query.cancel', () => {
    it('calls ipcRenderer.invoke with QUERY_CANCEL channel', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.query.cancel('q-123');

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.QUERY_CANCEL, {
        queryId: 'q-123',
      });
    });
  });

  describe('query.onStatus', () => {
    it('registers listener on QUERY_PROGRESS channel', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      api.query.onStatus(callback);

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
        PUSH_EVENTS.QUERY_PROGRESS,
        expect.any(Function),
      );
    });

    it('forwards status data to callback (strips IpcRendererEvent)', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      api.query.onStatus(callback);

      // Extract the handler passed to ipcRenderer.on for QUERY_PROGRESS
      const onCall = (electron.ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0] === PUSH_EVENTS.QUERY_PROGRESS,
      );
      const wrappedHandler = onCall?.[1];

      const statusData = {
        queryId: 'q1',
        phase: 'scanning',
        batchesStreamed: 0,
        elapsedMs: 100,
      };
      wrappedHandler({} /* IpcRendererEvent */, statusData);

      expect(callback).toHaveBeenCalledWith(statusData);
    });

    it('returns an unsubscribe function that removes listener', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const unsub = api.query.onStatus(vi.fn());
      unsub();

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
        PUSH_EVENTS.QUERY_PROGRESS,
        expect.any(Function),
      );
    });
  });

  describe('query.onData', () => {
    it('registers a data callback for a queryId', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      const unsub = api.query.onData('q1', callback);

      expect(unsub).toBeTypeOf('function');
    });

    it('allows multiple callbacks for the same queryId', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      api.query.onData('q1', cb1);
      api.query.onData('q1', cb2);

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('unsubscribe removes the specific callback', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const unsub1 = api.query.onData('q1', cb1);
      api.query.onData('q1', cb2);

      unsub1();

      // Verify cb1 removed but cb2 still active via port dispatch
      const port = createMockMessagePort();
      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

      port.onmessage?.({
        data: {
          type: 'arrow-batch',
          queryId: 'q1',
          index: 0,
          rowCount: 1,
          byteSize: 8,
          __transferredBuffers: [new ArrayBuffer(8)],
        },
      } as MessageEvent);

      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it('unsubscribe cleans up the Set when last callback removed', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const cb = vi.fn();
      const unsub = api.query.onData('q1', cb);
      unsub();

      // Registering again should work without issues (Set was deleted)
      const cb2 = vi.fn();
      api.query.onData('q1', cb2);
    });
  });

  describe('query.onQueryHistory', () => {
    it('registers listener on QUERY_HISTORY channel', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      api.query.onQueryHistory(callback);

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
        PUSH_EVENTS.QUERY_HISTORY,
        expect.any(Function),
      );
    });

    it('returns unsubscribe function', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const unsub = api.query.onQueryHistory(vi.fn());
      unsub();

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
        PUSH_EVENTS.QUERY_HISTORY,
        expect.any(Function),
      );
    });
  });

  // ========================================================================
  // catalog namespace
  // ========================================================================

  describe('catalog.listTables', () => {
    it('calls ipcRenderer.invoke with QUERY_LIST_TABLES', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.catalog.listTables();

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.QUERY_LIST_TABLES);
    });
  });

  describe('catalog.describeTable', () => {
    it('calls ipcRenderer.invoke with QUERY_DESCRIBE_TABLE and tableName', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.catalog.describeTable('users');

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.QUERY_DESCRIBE_TABLE, {
        tableName: 'users',
      });
    });
  });

  describe('catalog.previewTable', () => {
    it('calls ipcRenderer.invoke with CATALOG_PREVIEW, default limit 100', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.catalog.previewTable('products');

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CATALOG_PREVIEW, {
        tableName: 'products',
        limit: 100,
      });
    });

    it('passes explicit limit when provided', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.catalog.previewTable('products', 50);

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CATALOG_PREVIEW, {
        tableName: 'products',
        limit: 50,
      });
    });
  });

  // ========================================================================
  // lifecycle namespace
  // ========================================================================

  describe('lifecycle.ready', () => {
    it('calls ipcRenderer.invoke with LIFECYCLE_READY', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.lifecycle.ready();

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.LIFECYCLE_READY);
    });
  });

  describe('lifecycle.getAppState', () => {
    it('calls ipcRenderer.invoke with LIFECYCLE_GET_APP_STATE', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.lifecycle.getAppState();

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.LIFECYCLE_GET_APP_STATE,
      );
    });
  });

  describe('lifecycle.shutdownAck', () => {
    it('calls ipcRenderer.invoke with LIFECYCLE_SHUTDOWN_ACK', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      await api.lifecycle.shutdownAck();

      expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.LIFECYCLE_SHUTDOWN_ACK);
    });
  });

  describe('lifecycle.onWorkerHealth', () => {
    it('registers listener on WORKER_STATUS channel', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      api.lifecycle.onWorkerHealth(vi.fn());

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
        PUSH_EVENTS.WORKER_STATUS,
        expect.any(Function),
      );
    });

    it('returns unsubscribe function', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const unsub = api.lifecycle.onWorkerHealth(vi.fn());
      unsub();

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
        PUSH_EVENTS.WORKER_STATUS,
        expect.any(Function),
      );
    });
  });

  describe('lifecycle.onShutdownPrepare', () => {
    it('registers listener on SHUTDOWN_PREPARE channel', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      api.lifecycle.onShutdownPrepare(vi.fn());

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
        PUSH_EVENTS.SHUTDOWN_PREPARE,
        expect.any(Function),
      );
    });

    it('returns unsubscribe function', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const unsub = api.lifecycle.onShutdownPrepare(vi.fn());
      unsub();

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
        PUSH_EVENTS.SHUTDOWN_PREPARE,
        expect.any(Function),
      );
    });
  });

  describe('lifecycle.onBoundsChanged', () => {
    it('registers listener on WINDOW_BOUNDS_CHANGED channel', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      api.lifecycle.onBoundsChanged(vi.fn());

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
        PUSH_EVENTS.WINDOW_BOUNDS_CHANGED,
        expect.any(Function),
      );
    });

    it('forwards bounds data to callback', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      api.lifecycle.onBoundsChanged(callback);

      const onCall = (electron.ipcRenderer.on as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: any[]) => c[0] === PUSH_EVENTS.WINDOW_BOUNDS_CHANGED,
      );
      const wrappedHandler = onCall?.[1];

      const bounds = { x: 100, y: 200, width: 800, height: 600 };
      wrappedHandler({} /* IpcRendererEvent */, bounds);

      expect(callback).toHaveBeenCalledWith(bounds);
    });
  });

  // ========================================================================
  // MessagePort handling (PORT event + data plane)
  // ========================================================================

  describe('MessagePort handling', () => {
    it('stores port when PORT event received', async () => {
      await loadPreload();

      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      expect(portHandler).toBeDefined();
    });

    it('ignores PORT event when no port in event.ports', async () => {
      await loadPreload();

      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      // event.ports is empty
      portHandler?.({ ports: [] }, { channel: 'duckdb-data' });
      // Should not throw
    });

    it('sets up onmessage handler for duckdb-data port', async () => {
      await loadPreload();

      const port = createMockMessagePort();
      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

      expect(port.onmessage).toBeTypeOf('function');
      expect(port.start).toHaveBeenCalledOnce();
    });

    it('does not set up onmessage for non-duckdb-data channels', async () => {
      await loadPreload();

      const port = createMockMessagePort();
      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      portHandler?.({ ports: [port] }, { channel: 'some-other-channel' });

      expect(port.onmessage).toBeNull();
    });

    describe('arrow-batch messages', () => {
      it('dispatches arrow-batch to registered data callbacks', async () => {
        const electron = await loadPreload();
        const { api } = getExposedApi(electron);

        const callback = vi.fn();
        api.query.onData('q1', callback);

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        const testBuffer = new ArrayBuffer(16);
        port.onmessage?.({
          data: {
            type: 'arrow-batch',
            queryId: 'q1',
            index: 0,
            rowCount: 10,
            byteSize: 16,
            __transferredBuffers: [testBuffer],
          },
        } as MessageEvent);

        expect(callback).toHaveBeenCalledOnce();
        const batch = callback.mock.calls[0][0];
        expect(batch.buffer).toBe(testBuffer);
        expect(batch.index).toBe(0);
        expect(batch.rowCount).toBe(10);
        expect(batch.byteSize).toBe(16);
        expect(batch.isLast).toBe(false);
      });

      it('uses empty ArrayBuffer when no __transferredBuffers', async () => {
        const electron = await loadPreload();
        const { api } = getExposedApi(electron);

        const callback = vi.fn();
        api.query.onData('q1', callback);

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        port.onmessage?.({
          data: {
            type: 'arrow-batch',
            queryId: 'q1',
            index: 0,
            rowCount: 0,
            byteSize: 0,
          },
        } as MessageEvent);

        expect(callback).toHaveBeenCalledOnce();
        const batch = callback.mock.calls[0][0];
        expect(batch.buffer).toBeInstanceOf(ArrayBuffer);
        expect(batch.buffer.byteLength).toBe(0);
      });

      it('sends ACK for arrow-batch messages', async () => {
        const electron = await loadPreload();
        const { api } = getExposedApi(electron);

        api.query.onData('q1', vi.fn());

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        port.onmessage?.({
          data: {
            type: 'arrow-batch',
            queryId: 'q1',
            index: 3,
            rowCount: 10,
            byteSize: 100,
            __transferredBuffers: [new ArrayBuffer(100)],
          },
        } as MessageEvent);

        expect(port.postMessage).toHaveBeenCalledWith({
          type: 'ack',
          queryId: 'q1',
          index: 3,
        });
      });

      it('does not dispatch or ACK when no callbacks registered for queryId', async () => {
        await loadPreload();

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        port.onmessage?.({
          data: {
            type: 'arrow-batch',
            queryId: 'q-unknown',
            index: 0,
            rowCount: 10,
            byteSize: 100,
            __transferredBuffers: [new ArrayBuffer(100)],
          },
        } as MessageEvent);

        expect(port.postMessage).not.toHaveBeenCalled();
      });

      it('dispatches to all registered callbacks for a queryId', async () => {
        const electron = await loadPreload();
        const { api } = getExposedApi(electron);

        const cb1 = vi.fn();
        const cb2 = vi.fn();
        api.query.onData('q1', cb1);
        api.query.onData('q1', cb2);

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        port.onmessage?.({
          data: {
            type: 'arrow-batch',
            queryId: 'q1',
            index: 0,
            rowCount: 5,
            byteSize: 50,
            __transferredBuffers: [new ArrayBuffer(50)],
          },
        } as MessageEvent);

        expect(cb1).toHaveBeenCalledOnce();
        expect(cb2).toHaveBeenCalledOnce();
      });
    });

    describe('arrow-end messages', () => {
      it('dispatches arrow-end with isLast=true and correct fields', async () => {
        const electron = await loadPreload();
        const { api } = getExposedApi(electron);

        const callback = vi.fn();
        api.query.onData('q1', callback);

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        port.onmessage?.({
          data: {
            type: 'arrow-end',
            queryId: 'q1',
            totalBatches: 5,
            totalRows: 500,
            totalBytes: 4096,
            durationMs: 123,
          },
        } as MessageEvent);

        expect(callback).toHaveBeenCalledOnce();
        const batch = callback.mock.calls[0][0];
        expect(batch.buffer).toBeInstanceOf(ArrayBuffer);
        expect(batch.buffer.byteLength).toBe(0);
        expect(batch.index).toBe(5);
        expect(batch.rowCount).toBe(500);
        expect(batch.byteSize).toBe(4096);
        expect(batch.isLast).toBe(true);
      });

      it('does not dispatch when no callbacks for queryId', async () => {
        await loadPreload();

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        // Should not throw
        port.onmessage?.({
          data: {
            type: 'arrow-end',
            queryId: 'q-no-listener',
            totalBatches: 0,
            totalRows: 0,
            totalBytes: 0,
            durationMs: 0,
          },
        } as MessageEvent);
      });
    });

    describe('arrow-error messages', () => {
      it('dispatches arrow-error with isLast=true and zero-filled batch', async () => {
        const electron = await loadPreload();
        const { api } = getExposedApi(electron);

        const callback = vi.fn();
        api.query.onData('q1', callback);

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        port.onmessage?.({
          data: {
            type: 'arrow-error',
            queryId: 'q1',
            code: 'E1001',
            message: 'syntax error',
            batchesSent: 0,
          },
        } as MessageEvent);

        expect(callback).toHaveBeenCalledOnce();
        const batch = callback.mock.calls[0][0];
        expect(batch.buffer.byteLength).toBe(0);
        expect(batch.index).toBe(0);
        expect(batch.rowCount).toBe(0);
        expect(batch.byteSize).toBe(0);
        expect(batch.isLast).toBe(true);
      });

      it('does not dispatch when no callbacks for queryId', async () => {
        await loadPreload();

        const port = createMockMessagePort();
        const portHandler = handlers.get(PUSH_EVENTS.PORT);
        portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

        // Should not throw
        port.onmessage?.({
          data: {
            type: 'arrow-error',
            queryId: 'q-no-listener',
            code: 'E1001',
            message: 'something broke',
            batchesSent: 0,
          },
        } as MessageEvent);
      });
    });
  });
});
