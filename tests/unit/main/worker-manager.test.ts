import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock worker_threads
const mockWorkerInstance = {
  on: vi.fn(),
  once: vi.fn(),
  postMessage: vi.fn(),
  terminate: vi.fn(),
  _handlers: {} as Record<string, ((...args: any[]) => void)[]>,
};

vi.mock('worker_threads', () => ({
  Worker: vi.fn().mockImplementation(() => {
    // Reset handlers for each new instance
    mockWorkerInstance._handlers = {};
    mockWorkerInstance.on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!mockWorkerInstance._handlers[event]) mockWorkerInstance._handlers[event] = [];
      mockWorkerInstance._handlers[event].push(handler);
    });
    mockWorkerInstance.once = vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!mockWorkerInstance._handlers[event]) mockWorkerInstance._handlers[event] = [];
      mockWorkerInstance._handlers[event].push(handler);
    });
    mockWorkerInstance.postMessage = vi.fn();
    mockWorkerInstance.terminate = vi.fn();
    return mockWorkerInstance;
  }),
}));

import { WorkerManager } from '@main/worker-manager';

const defaultConfig = {
  dbPath: '/tmp/test.duckdb',
  memoryLimit: '1024MB',
  threads: 4,
  tempDirectory: '/tmp',
  extensions: ['parquet'],
  v8HeapLimitMB: 512,
  healthCheckIntervalMs: 60_000,
  heartbeatTimeoutMs: 5_000,
  maxRestartAttempts: 3,
};

function createMockBrowserWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
}

function triggerWorkerMessage(msg: Record<string, unknown>) {
  const msgHandlers = mockWorkerInstance._handlers['message'] ?? [];
  msgHandlers.forEach((h) => {
    h(msg);
  });
}

function triggerWorkerError(err: Error) {
  const errorHandlers = mockWorkerInstance._handlers['error'] ?? [];
  errorHandlers.forEach((h) => {
    h(err);
  });
}

function triggerWorkerExit(code: number) {
  const exitHandlers = mockWorkerInstance._handlers['exit'] ?? [];
  exitHandlers.forEach((h) => {
    h(code);
  });
}

describe('WorkerManager', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    manager = new WorkerManager(defaultConfig);
  });

  afterEach(() => {
    manager.stopHealthMonitoring();
    vi.useRealTimers();
  });

  describe('spawn', () => {
    it('resolves when worker sends ready message', async () => {
      const spawnPromise = manager.spawn();

      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });

      await expect(spawnPromise).resolves.toBeUndefined();
      expect(manager.getStatus()).toBe('ready');
    });

    it('rejects on startup timeout', async () => {
      const spawnPromise = manager.spawn();

      vi.advanceTimersByTime(31_000);

      await expect(spawnPromise).rejects.toThrow('Worker startup timed out');
    });

    it('sets restart count to 0 initially', () => {
      expect(manager.getRestartCount()).toBe(0);
    });
  });

  describe('getWorker', () => {
    it('returns null before spawn', () => {
      expect(manager.getWorker()).toBeNull();
    });

    it('returns worker instance after spawn', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(manager.getWorker()).toBeDefined();
    });
  });

  describe('health monitoring', () => {
    it('starts sending heartbeats at configured interval', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      manager.startHealthMonitoring();

      vi.advanceTimersByTime(60_000);

      expect(mockWorkerInstance.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat' }),
      );
    });

    it('does not start duplicate intervals', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      manager.startHealthMonitoring();
      manager.startHealthMonitoring(); // second call should be no-op

      vi.advanceTimersByTime(60_000);

      const heartbeats = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0].type === 'heartbeat',
      );
      expect(heartbeats).toHaveLength(1);
    });

    it('stops sending heartbeats when monitoring is stopped', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      manager.startHealthMonitoring();
      manager.stopHealthMonitoring();

      mockWorkerInstance.postMessage.mockClear();
      vi.advanceTimersByTime(120_000);

      const heartbeats = mockWorkerInstance.postMessage.mock.calls.filter(
        (c) => c[0].type === 'heartbeat',
      );
      expect(heartbeats).toHaveLength(0);
    });
  });

  describe('heartbeat ack handling', () => {
    it('sets status to busy on busy ack', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'busy',
      });

      expect(manager.getStatus()).toBe('busy');
    });

    it('sets status to ready on healthy ack', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // First set to busy
      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'busy',
      });

      // Then back to ready
      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'healthy',
      });

      expect(manager.getStatus()).toBe('ready');
    });

    it('sets status to degraded on degraded ack', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'degraded',
      });

      expect(manager.getStatus()).toBe('degraded');
    });
  });

  describe('worker error handling', () => {
    it('sets status to degraded on worker error', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerError(new Error('heap out of memory'));

      expect(manager.getStatus()).toBe('degraded');
    });
  });

  describe('worker exit and restart', () => {
    it('attempts restart on non-zero exit code', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerExit(1);

      expect(manager.getStatus()).toBe('restarting');
      expect(manager.getRestartCount()).toBe(1);
    });

    it('sets status to failed after max restart attempts', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Exhaust restart attempts (3 max)
      for (let i = 0; i < 3; i++) {
        triggerWorkerExit(1);
        // Each restart spawn needs a ready (or timeout)
        // After max attempts it should fail without trying to spawn
      }

      // After 3 restarts, the 4th exit should set to failed
      triggerWorkerExit(1);

      expect(manager.getStatus()).toBe('failed');
    });

    it('does not restart on clean exit (code 0) when not failed', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerExit(0);

      expect(manager.getRestartCount()).toBe(0);
    });
  });

  describe('getHealthRecord', () => {
    it('returns health record with correct shape', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      const record = manager.getHealthRecord();

      expect(record.id).toBe('duckdb');
      expect(record.status).toBe('ready');
      expect(record.restartCount).toBe(0);
      expect(record.lastHeartbeatAt).toBeTruthy();
      expect(record.upSince).toBeTruthy();
      expect(record.activeQueryCount).toBe(0);
    });

    it('maps starting status to ready', () => {
      // Before spawn, status is 'starting'
      const record = manager.getHealthRecord();
      expect(record.status).toBe('ready');
    });
  });

  describe('shutdown', () => {
    it('sends shutdown message to worker', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      const shutdownPromise = manager.shutdown();

      // Simulate shutdown-complete
      const shutdownHandlers = mockWorkerInstance._handlers['message'] ?? [];
      shutdownHandlers.forEach((h) => {
        h({ type: 'shutdown-complete', worker: 'duckdb' });
      });

      await expect(shutdownPromise).resolves.toBeUndefined();
    });

    it('terminates worker on timeout', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      const shutdownPromise = manager.shutdown();

      // Don't send shutdown-complete, just let it timeout
      vi.advanceTimersByTime(6_000);

      await expect(shutdownPromise).resolves.toBeUndefined();
      expect(mockWorkerInstance.terminate).toHaveBeenCalled();
    });

    it('resolves immediately when no worker', async () => {
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('renderer push', () => {
    it('pushes health status to renderer', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(win.webContents.send).toHaveBeenCalledWith(
        'worker:status',
        expect.objectContaining({
          worker: 'duckdb',
          status: 'ready',
        }),
      );
    });

    it('does not push when window is destroyed', async () => {
      const win = createMockBrowserWindow();
      win.isDestroyed.mockReturnValue(true);
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('query history forwarding', () => {
    it('forwards query history records to renderer', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({
        type: 'query_history_record',
        queryId: 'q1',
        sql: 'SELECT 1',
        executionTimeMs: 50,
        rowCount: 1,
        status: 'success',
      });

      expect(win.webContents.send).toHaveBeenCalledWith(
        'query:history',
        expect.objectContaining({
          queryId: 'q1',
          sql: 'SELECT 1',
          executionTimeMs: 50,
          rowCount: 1,
          status: 'success',
        }),
      );
    });
  });
});
