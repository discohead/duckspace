import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron
const mockHandlers = new Map<string, (...args: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: any) => {
      mockHandlers.set(channel, handler);
    }),
  },
  BrowserWindow: vi.fn(),
  MessageChannelMain: vi.fn(() => ({
    port1: { on: vi.fn(), start: vi.fn(), postMessage: vi.fn() },
    port2: { on: vi.fn(), start: vi.fn(), postMessage: vi.fn() },
  })),
  app: {
    getPath: vi.fn(() => '/tmp/test'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

vi.mock('node:worker_threads', () => ({
  MessageChannel: vi.fn(() => ({
    port1: { on: vi.fn(), postMessage: vi.fn() },
    port2: { on: vi.fn(), postMessage: vi.fn() },
  })),
}));

// Mock config
vi.mock('@main/config', () => ({
  getConfig: vi.fn(() => ({
    duckdb: { memoryLimitPercent: 50, memoryLimitOverrideMB: null, threads: null, extensions: [] },
    paths: { database: 'test.duckdb', tempDir: 'tmp', config: 'config.json' },
    workers: {
      healthCheckIntervalMs: 60000,
      heartbeatTimeoutMs: 5000,
      maxRestartAttempts: 3,
      v8HeapLimitMB: 512,
    },
    ui: { theme: 'system', fontSize: 14, defaultQueryLimit: 1000 },
    lifecycle: { shutdownTimeoutMs: 6000, walCheckpointOnShutdown: true },
  })),
  setConfigValue: vi.fn(),
  getConfigValue: vi.fn(),
  computeMemoryLimit: vi.fn(() => '4096MB'),
}));

import {
  registerIPCHandlers,
  sendShutdownPrepare,
  setMainWindowRef,
  setQueryRouter,
  setWorkerManager,
  waitForRendererReady,
  waitForShutdownAck,
} from '@main/ipc-handlers';
import { IPC_CHANNELS } from '@shared/constants';

describe('IPC Handlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Register handlers once; idempotent guard means subsequent calls are no-ops.
    // We do NOT clear mockHandlers — the handlers persist and close over module-level refs.
    registerIPCHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerIPCHandlers', () => {
    it('registers all IPC channels', () => {
      for (const channel of Object.values(IPC_CHANNELS)) {
        expect(mockHandlers.has(channel)).toBe(true);
      }
    });
  });

  describe('query handlers', () => {
    it('query:execute delegates to QueryRouter', async () => {
      const mockRouter = {
        executeQuery: vi.fn().mockResolvedValue({ queryId: 'q1' }),
      };
      setQueryRouter(mockRouter as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_EXECUTE)!;
      const result = await handler({}, { sql: 'SELECT 1', params: [] });

      expect(mockRouter.executeQuery).toHaveBeenCalledWith('SELECT 1', []);
      expect(result).toEqual({ queryId: 'q1' });
    });

    it('query:execute throws when router not set', async () => {
      setQueryRouter(null as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_EXECUTE)!;
      await expect(handler({}, { sql: 'SELECT 1' })).rejects.toThrow('QueryRouter not initialized');
    });

    it('query:cancel delegates to QueryRouter', async () => {
      const mockRouter = {
        cancelQuery: vi.fn().mockResolvedValue(undefined),
      };
      setQueryRouter(mockRouter as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_CANCEL)!;
      await handler({}, { queryId: 'q1' });

      expect(mockRouter.cancelQuery).toHaveBeenCalledWith('q1');
    });

    it('query:listTables delegates to QueryRouter', async () => {
      const tables = [{ name: 'users' }];
      const mockRouter = {
        listTables: vi.fn().mockResolvedValue(tables),
      };
      setQueryRouter(mockRouter as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_LIST_TABLES)!;
      const result = await handler({});

      expect(result).toEqual(tables);
    });

    it('query:describeTable delegates to QueryRouter', async () => {
      const columns = [{ name: 'id' }];
      const mockRouter = {
        describeTable: vi.fn().mockResolvedValue(columns),
      };
      setQueryRouter(mockRouter as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_DESCRIBE_TABLE)!;
      const result = await handler({}, { tableName: 'users' });

      expect(mockRouter.describeTable).toHaveBeenCalledWith('users');
      expect(result).toEqual(columns);
    });

    it('catalog:preview delegates to QueryRouter', async () => {
      const mockRouter = {
        previewTable: vi.fn().mockResolvedValue({ queryId: 'q1' }),
      };
      setQueryRouter(mockRouter as any);

      const handler = mockHandlers.get(IPC_CHANNELS.CATALOG_PREVIEW)!;
      const result = await handler({}, { tableName: 'users', limit: 50 });

      expect(mockRouter.previewTable).toHaveBeenCalledWith('users', 50);
      expect(result).toEqual({ queryId: 'q1' });
    });
  });

  describe('lifecycle handlers', () => {
    it('lifecycle:getAppState returns app state', async () => {
      const mockManager = { getStatus: vi.fn(() => 'ready') };
      setWorkerManager(mockManager as any);

      const handler = mockHandlers.get(IPC_CHANNELS.LIFECYCLE_GET_APP_STATE)!;
      const result = await handler({});

      expect(result).toMatchObject({
        memory: expect.objectContaining({ duckdbLimitMB: 4096 }),
        workers: { duckdb: 'ready' },
        shutdownStatus: 'dirty',
      });
    });

    it('lifecycle:ready resolves pending promise', async () => {
      const readyPromise = waitForRendererReady();
      const handler = mockHandlers.get(IPC_CHANNELS.LIFECYCLE_READY)!;
      await handler({});

      await expect(readyPromise).resolves.toBeUndefined();
    });

    it('lifecycle:shutdownAck resolves pending promise', async () => {
      const ackPromise = waitForShutdownAck(5000);
      const handler = mockHandlers.get(IPC_CHANNELS.LIFECYCLE_SHUTDOWN_ACK)!;
      await handler({});

      await expect(ackPromise).resolves.toBe(true);
    });

    it('waitForShutdownAck resolves false on timeout', async () => {
      const ackPromise = waitForShutdownAck(1000);
      vi.advanceTimersByTime(1001);

      await expect(ackPromise).resolves.toBe(false);
    });
  });

  describe('config handlers', () => {
    it('config:getAll returns full config', async () => {
      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_GET_ALL)!;
      const result = await handler({});

      expect(result).toBeDefined();
      expect(result.ui.theme).toBe('system');
    });

    it('config:get returns nested value', async () => {
      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_GET)!;
      const result = await handler({}, { key: 'ui.theme' });

      expect(result).toBe('system');
    });
  });

  // I3: config:set validation
  describe('config:set validation', () => {
    it('rejects invalid config value', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_SET)!;

      // fontSize expects a number — a string will fail Zod validation
      // (theme has .catch('system') which silently recovers invalid values)
      await handler({}, { key: 'ui.fontSize', value: 'not-a-number' });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('config:set rejected'),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });

    it('accepts valid config value', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { setConfigValue: mockSetConfigValue } = await import('@main/config');
      vi.mocked(mockSetConfigValue).mockClear();

      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_SET)!;
      await handler({}, { key: 'ui.theme', value: 'dark' });

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(mockSetConfigValue).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('ignores unknown section keys', async () => {
      const { setConfigValue: mockSetConfigValue } = await import('@main/config');
      vi.mocked(mockSetConfigValue).mockClear();

      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_SET)!;
      await handler({}, { key: 'unknown.field', value: 'test' });

      expect(mockSetConfigValue).not.toHaveBeenCalled();
    });
  });

  // C5: IPC error boundary logging
  describe('wrapIPCHandler error boundary', () => {
    it('logs and re-throws errors from query:execute', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // queryRouter is null => handler throws
      setQueryRouter(null as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_EXECUTE)!;
      await expect(handler({}, { sql: 'SELECT 1' })).rejects.toThrow('QueryRouter not initialized');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('IPC handler error'),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });

    it('logs and re-throws errors from query:cancel', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      setQueryRouter(null as any);

      const handler = mockHandlers.get(IPC_CHANNELS.QUERY_CANCEL)!;
      await expect(handler({}, { queryId: 'q1' })).rejects.toThrow('QueryRouter not initialized');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('IPC handler error'),
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  // C7: waitForRendererReady timeout
  describe('waitForRendererReady timeout', () => {
    it('rejects after timeout if renderer never signals ready', async () => {
      const promise = waitForRendererReady(500);
      vi.advanceTimersByTime(501);

      await expect(promise).rejects.toThrow('Renderer did not signal ready within 500ms');
    });

    it('resolves before timeout on ready signal', async () => {
      const promise = waitForRendererReady(5000);
      const handler = mockHandlers.get(IPC_CHANNELS.LIFECYCLE_READY)!;
      await handler({});

      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('sendShutdownPrepare', () => {
    it('sends shutdown-prepare to window', () => {
      const mockWindow = {
        isDestroyed: vi.fn(() => false),
        webContents: { send: vi.fn() },
      };
      setMainWindowRef(mockWindow as any);

      sendShutdownPrepare();

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('shutdown-prepare');
    });

    it('does nothing when window is destroyed', () => {
      const mockWindow = {
        isDestroyed: vi.fn(() => true),
        webContents: { send: vi.fn() },
      };
      setMainWindowRef(mockWindow as any);

      sendShutdownPrepare();

      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });
  });
});
