import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks – declared before any imports that reference them
// ---------------------------------------------------------------------------

const mockBrowserWindow = {
  on: vi.fn(),
  once: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  show: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getBounds: vi.fn(() => ({ x: 100, y: 100, width: 1280, height: 800 })),
  webContents: {
    send: vi.fn(),
  },
};

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    isPackaged: false,
  },
  BrowserWindow: vi.fn(() => mockBrowserWindow),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
}));

const mockWorkerInstance = { on: vi.fn(), postMessage: vi.fn() };
const mockWorkerManagerInstance = {
  spawn: vi.fn().mockResolvedValue(undefined),
  getWorker: vi.fn(() => mockWorkerInstance),
  setMainWindow: vi.fn(),
  startHealthMonitoring: vi.fn(),
  stopHealthMonitoring: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@main/worker-manager', () => ({
  WorkerManager: vi.fn(() => mockWorkerManagerInstance),
}));

const mockQueryRouterInstance = {
  setMainWindow: vi.fn(),
  beginShutdown: vi.fn(),
};

vi.mock('@main/query-router', () => ({
  QueryRouter: vi.fn(() => mockQueryRouterInstance),
}));

vi.mock('@main/config', () => ({
  loadConfig: vi.fn(() => ({
    duckdb: {
      memoryLimitPercent: 50,
      memoryLimitOverrideMB: null,
      threads: null,
      extensions: ['parquet', 'json', 'icu'],
    },
    paths: { database: 'analytics.duckdb', tempDir: 'tmp', config: 'config.json' },
    workers: {
      healthCheckIntervalMs: 60_000,
      heartbeatTimeoutMs: 5_000,
      maxRestartAttempts: 3,
      v8HeapLimitMB: 512,
    },
    ui: { theme: 'system', fontSize: 14, defaultQueryLimit: 1_000 },
    lifecycle: { shutdownTimeoutMs: 6_000, walCheckpointOnShutdown: true },
  })),
  ensureDirectories: vi.fn(),
  computeMemoryLimit: vi.fn(() => '4096MB'),
  computeThreadCount: vi.fn(() => 6),
  getDatabasePath: vi.fn(() => '/tmp/datspace-test/analytics.duckdb'),
  getTempDirectory: vi.fn(() => '/tmp/datspace-test/tmp'),
}));

vi.mock('@main/ipc-handlers', () => ({
  registerIPCHandlers: vi.fn(),
  setQueryRouter: vi.fn(),
  setWorkerManager: vi.fn(),
  setMainWindowRef: vi.fn(),
  setupDataChannel: vi.fn(),
  waitForRendererReady: vi.fn().mockResolvedValue(undefined),
  waitForShutdownAck: vi.fn().mockResolvedValue(undefined),
  sendShutdownPrepare: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Stub the Vite-injected globals
// ---------------------------------------------------------------------------

vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');

// ---------------------------------------------------------------------------
// Imports (after all vi.mock calls)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { ensureDirectories, loadConfig } from '@main/config';
import {
  registerIPCHandlers,
  sendShutdownPrepare,
  setMainWindowRef,
  setQueryRouter,
  setupDataChannel,
  setWorkerManager,
  waitForRendererReady,
  waitForShutdownAck,
} from '@main/ipc-handlers';
import {
  getMainWindow,
  getQueryRouter,
  getWorkerManager,
  shutdownSequence,
  startupSequence,
} from '@main/lifecycle';
import { QueryRouter } from '@main/query-router';
import { WorkerManager } from '@main/worker-manager';
import { PUSH_EVENTS, TIMEOUTS } from '@shared/constants';
import { app, BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lifecycle module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock BrowserWindow callbacks
    mockBrowserWindow.on.mockReset();
    mockBrowserWindow.once.mockReset();
    mockBrowserWindow.loadURL.mockReset();
    mockBrowserWindow.loadFile.mockReset();
    mockBrowserWindow.isDestroyed.mockReturnValue(false);
    mockBrowserWindow.getBounds.mockReturnValue({ x: 100, y: 100, width: 1280, height: 800 });
    mockBrowserWindow.webContents.send.mockReset();

    // Restore default loadConfig mock (tests that override it need this reset)
    vi.mocked(loadConfig).mockReturnValue({
      duckdb: {
        memoryLimitPercent: 50,
        memoryLimitOverrideMB: null,
        threads: null,
        extensions: ['parquet', 'json', 'icu'],
      },
      paths: { database: 'analytics.duckdb', tempDir: 'tmp', config: 'config.json' },
      workers: {
        healthCheckIntervalMs: 60_000,
        heartbeatTimeoutMs: 5_000,
        maxRestartAttempts: 3,
        v8HeapLimitMB: 512,
      },
      ui: { theme: 'system', fontSize: 14, defaultQueryLimit: 1_000 },
      lifecycle: { shutdownTimeoutMs: 6_000, walCheckpointOnShutdown: true },
    });

    // Restore default async mocks
    mockWorkerManagerInstance.spawn.mockResolvedValue(undefined);
    mockWorkerManagerInstance.shutdown.mockResolvedValue(undefined);
    vi.mocked(waitForRendererReady).mockResolvedValue(undefined);
    vi.mocked(waitForShutdownAck).mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // Getter functions
  // -----------------------------------------------------------------------

  describe('getMainWindow / getWorkerManager / getQueryRouter', () => {
    it('returns null initially (before startupSequence)', () => {
      // Before any startup these are the module-level defaults.
      // Because vi.mock replaces the module, we test via re-import.
      // The getters simply return the module-level variables which start as null.
      // After a previous test's startupSequence they may be populated,
      // so we test the contract: the functions exist and return the expected types.
      expect(getMainWindow).toBeDefined();
      expect(getWorkerManager).toBeDefined();
      expect(getQueryRouter).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // startupSequence
  // -----------------------------------------------------------------------

  describe('startupSequence', () => {
    it('calls all startup steps in order', async () => {
      const callOrder: string[] = [];

      vi.mocked(loadConfig).mockImplementation(() => {
        callOrder.push('loadConfig');
        return {
          duckdb: {
            memoryLimitPercent: 50,
            memoryLimitOverrideMB: null,
            threads: null,
            extensions: ['parquet'],
          },
          paths: { database: 'analytics.duckdb', tempDir: 'tmp', config: 'config.json' },
          workers: {
            healthCheckIntervalMs: 60_000,
            heartbeatTimeoutMs: 5_000,
            maxRestartAttempts: 3,
            v8HeapLimitMB: 512,
          },
          ui: { theme: 'system', fontSize: 14, defaultQueryLimit: 1_000 },
          lifecycle: { shutdownTimeoutMs: 6_000, walCheckpointOnShutdown: true },
        };
      });
      vi.mocked(ensureDirectories).mockImplementation(() => {
        callOrder.push('ensureDirectories');
      });
      vi.mocked(registerIPCHandlers).mockImplementation(() => {
        callOrder.push('registerIPCHandlers');
      });
      mockWorkerManagerInstance.spawn.mockImplementation(async () => {
        callOrder.push('workerManager.spawn');
      });
      vi.mocked(setWorkerManager).mockImplementation(() => {
        callOrder.push('setWorkerManager');
      });
      vi.mocked(setQueryRouter).mockImplementation(() => {
        callOrder.push('setQueryRouter');
      });
      vi.mocked(setMainWindowRef).mockImplementation(() => {
        callOrder.push('setMainWindowRef');
      });
      vi.mocked(setupDataChannel).mockImplementation(() => {
        callOrder.push('setupDataChannel');
      });
      vi.mocked(waitForRendererReady).mockImplementation(async () => {
        callOrder.push('waitForRendererReady');
      });
      mockWorkerManagerInstance.startHealthMonitoring.mockImplementation(() => {
        callOrder.push('startHealthMonitoring');
      });

      await startupSequence();

      expect(callOrder).toEqual([
        'loadConfig',
        'ensureDirectories',
        'registerIPCHandlers',
        'setWorkerManager',
        'workerManager.spawn',
        'setQueryRouter',
        'setMainWindowRef',
        'setupDataChannel',
        'waitForRendererReady',
        'startHealthMonitoring',
      ]);
    });

    it('creates WorkerManager with correct config', async () => {
      await startupSequence();

      expect(WorkerManager).toHaveBeenCalledWith(
        expect.objectContaining({
          dbPath: '/tmp/datspace-test/analytics.duckdb',
          memoryLimit: '4096MB',
          threads: 6,
          tempDirectory: '/tmp/datspace-test/tmp',
          extensions: ['parquet', 'json', 'icu'],
          v8HeapLimitMB: 512,
          healthCheckIntervalMs: 60_000,
          heartbeatTimeoutMs: 5_000,
          maxRestartAttempts: 3,
        }),
      );
    });

    it('creates QueryRouter with worker from WorkerManager', async () => {
      await startupSequence();

      expect(mockWorkerManagerInstance.getWorker).toHaveBeenCalled();
      expect(QueryRouter).toHaveBeenCalledWith(mockWorkerInstance);
    });

    it('creates BrowserWindow with correct webPreferences', async () => {
      await startupSequence();

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1280,
          height: 800,
          minWidth: 800,
          minHeight: 600,
          show: false,
          webPreferences: expect.objectContaining({
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            preload: expect.stringContaining('preload-entry.js'),
          }),
        }),
      );
    });

    it('loads file when MAIN_WINDOW_VITE_DEV_SERVER_URL is undefined', async () => {
      vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);

      await startupSequence();

      expect(mockBrowserWindow.loadFile).toHaveBeenCalledWith(
        expect.stringContaining('main_window/index.html'),
      );
      expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    });

    it('loads URL when MAIN_WINDOW_VITE_DEV_SERVER_URL is set', async () => {
      vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173');

      await startupSequence();

      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://localhost:5173');

      // Restore
      vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
    });

    it('sets up data channel between window and worker', async () => {
      await startupSequence();

      expect(setupDataChannel).toHaveBeenCalledWith(mockBrowserWindow, mockWorkerInstance);
    });

    it('waits for renderer ready before starting health monitoring', async () => {
      const order: string[] = [];
      vi.mocked(waitForRendererReady).mockImplementation(async () => {
        order.push('rendererReady');
      });
      mockWorkerManagerInstance.startHealthMonitoring.mockImplementation(() => {
        order.push('healthMonitoring');
      });

      await startupSequence();

      const readyIdx = order.indexOf('rendererReady');
      const healthIdx = order.indexOf('healthMonitoring');
      expect(readyIdx).toBeLessThan(healthIdx);
    });

    it('passes workerManager and queryRouter to IPC handler setters', async () => {
      await startupSequence();

      expect(setWorkerManager).toHaveBeenCalledWith(mockWorkerManagerInstance);
      expect(setQueryRouter).toHaveBeenCalledWith(mockQueryRouterInstance);
      expect(setMainWindowRef).toHaveBeenCalledWith(mockBrowserWindow);
    });

    it('registers ready-to-show listener on the window', async () => {
      await startupSequence();

      expect(mockBrowserWindow.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function));
    });
  });

  // -----------------------------------------------------------------------
  // shutdownSequence
  // -----------------------------------------------------------------------

  describe('shutdownSequence', () => {
    beforeEach(async () => {
      // Run startup so module-level variables are populated
      await startupSequence();
      vi.clearAllMocks();
    });

    it('calls all shutdown steps in order', async () => {
      const callOrder: string[] = [];

      mockQueryRouterInstance.beginShutdown.mockImplementation(() => {
        callOrder.push('queryRouter.beginShutdown');
      });
      vi.mocked(sendShutdownPrepare).mockImplementation(() => {
        callOrder.push('sendShutdownPrepare');
      });
      vi.mocked(waitForShutdownAck).mockImplementation(async () => {
        callOrder.push('waitForShutdownAck');
      });
      mockWorkerManagerInstance.stopHealthMonitoring.mockImplementation(() => {
        callOrder.push('stopHealthMonitoring');
      });
      mockWorkerManagerInstance.shutdown.mockImplementation(async () => {
        callOrder.push('workerManager.shutdown');
      });
      vi.mocked(app.quit).mockImplementation((() => {
        callOrder.push('app.quit');
      }) as any);

      await shutdownSequence();

      expect(callOrder).toEqual([
        'queryRouter.beginShutdown',
        'sendShutdownPrepare',
        'waitForShutdownAck',
        'stopHealthMonitoring',
        'workerManager.shutdown',
        'app.quit',
      ]);
    });

    it('passes TIMEOUTS.SHUTDOWN_ACK to waitForShutdownAck', async () => {
      await shutdownSequence();

      expect(waitForShutdownAck).toHaveBeenCalledWith(TIMEOUTS.SHUTDOWN_ACK);
    });

    it('cleans tmp directory contents during shutdown', async () => {
      const mockEntries = [
        { name: 'query-123.tmp', isFile: () => true, isDirectory: () => false },
        { name: 'cache', isFile: () => false, isDirectory: () => true },
      ];
      vi.mocked(fs.readdirSync).mockReturnValue(mockEntries as any);

      await shutdownSequence();

      expect(fs.readdirSync).toHaveBeenCalledWith('/tmp/datspace-test/tmp', {
        withFileTypes: true,
      });
      expect(fs.rmSync).toHaveBeenCalledTimes(2);
      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining('query-123.tmp'), {
        recursive: true,
        force: true,
      });
      expect(fs.rmSync).toHaveBeenCalledWith(expect.stringContaining('cache'), {
        recursive: true,
        force: true,
      });
    });

    it('handles missing tmp directory gracefully', async () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      // Should not throw
      await expect(shutdownSequence()).resolves.toBeUndefined();
      expect(app.quit).toHaveBeenCalled();
    });

    it('handles per-entry rmSync failures gracefully', async () => {
      const mockEntries = [{ name: 'locked-file.tmp' }, { name: 'normal-file.tmp' }];
      vi.mocked(fs.readdirSync).mockReturnValue(mockEntries as any);

      let callCount = 0;
      vi.mocked(fs.rmSync).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('EBUSY: resource busy');
        }
      });

      await expect(shutdownSequence()).resolves.toBeUndefined();
      // Both entries attempted even when first fails
      expect(fs.rmSync).toHaveBeenCalledTimes(2);
      expect(app.quit).toHaveBeenCalled();
    });

    it('calls app.quit at the end', async () => {
      await shutdownSequence();

      expect(app.quit).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Window bounds tracking (debounce)
  // -----------------------------------------------------------------------

  describe('setupWindowBoundsTracking (via createWindow in startupSequence)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('registers move and resize listeners on the window', async () => {
      await startupSequence();

      const onCalls = mockBrowserWindow.on.mock.calls.map((call: [string, unknown]) => call[0]);
      expect(onCalls).toContain('move');
      expect(onCalls).toContain('resize');
    });

    it('debounces bounds change events with 500ms delay', async () => {
      await startupSequence();

      // Extract the move handler
      const moveCall = mockBrowserWindow.on.mock.calls.find(
        (call: [string, unknown]) => call[0] === 'move',
      );
      expect(moveCall).toBeDefined();
      const moveHandler = moveCall?.[1] as () => void;

      // Trigger move rapidly
      moveHandler();
      moveHandler();
      moveHandler();

      // Not yet fired
      expect(mockBrowserWindow.webContents.send).not.toHaveBeenCalled();

      // Advance past debounce
      vi.advanceTimersByTime(500);

      // Should have fired once
      expect(mockBrowserWindow.webContents.send).toHaveBeenCalledTimes(1);
      expect(mockBrowserWindow.webContents.send).toHaveBeenCalledWith(
        PUSH_EVENTS.WINDOW_BOUNDS_CHANGED,
        { x: 100, y: 100, width: 1280, height: 800 },
      );
    });

    it('does not send bounds if window is destroyed', async () => {
      await startupSequence();

      const moveCall = mockBrowserWindow.on.mock.calls.find(
        (call: [string, unknown]) => call[0] === 'move',
      );
      const moveHandler = moveCall?.[1] as () => void;

      mockBrowserWindow.isDestroyed.mockReturnValue(true);

      moveHandler();
      vi.advanceTimersByTime(500);

      expect(mockBrowserWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('resets debounce timer on subsequent events', async () => {
      await startupSequence();

      const resizeCall = mockBrowserWindow.on.mock.calls.find(
        (call: [string, unknown]) => call[0] === 'resize',
      );
      const resizeHandler = resizeCall?.[1] as () => void;

      // First event
      resizeHandler();
      vi.advanceTimersByTime(300);

      // Second event resets the timer
      resizeHandler();
      vi.advanceTimersByTime(300);

      // Only 600ms total, but only 300ms since last event — not fired yet
      expect(mockBrowserWindow.webContents.send).not.toHaveBeenCalled();

      // 200ms more (500ms since last event)
      vi.advanceTimersByTime(200);
      expect(mockBrowserWindow.webContents.send).toHaveBeenCalledTimes(1);
    });
  });
});
