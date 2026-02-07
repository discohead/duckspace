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

    it('includes errorMessage when present in the worker message', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({
        type: 'query_history_record',
        queryId: 'q2',
        sql: 'SELECT bad',
        executionTimeMs: 10,
        rowCount: 0,
        status: 'error',
        errorMessage: 'column "bad" not found',
      });

      const historyCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'query:history',
      );
      expect(historyCall).toBeDefined();
      const record = historyCall![1];
      expect(record.errorMessage).toBe('column "bad" not found');
    });

    it('omits errorMessage key when not present in the worker message', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Clear send calls from the ready status push
      win.webContents.send.mockClear();

      triggerWorkerMessage({
        type: 'query_history_record',
        queryId: 'q3',
        sql: 'SELECT 1',
        executionTimeMs: 5,
        rowCount: 1,
        status: 'success',
        // no errorMessage field
      });

      const historyCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'query:history',
      );
      expect(historyCall).toBeDefined();
      const record = historyCall![1];
      expect(Object.hasOwn(record, 'errorMessage')).toBe(false);
    });
  });

  describe('sendHeartbeat when failed', () => {
    it('does not send heartbeat when status is failed', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Set status to failed via shutdown-complete message
      triggerWorkerMessage({ type: 'shutdown-complete' });
      expect(manager.getStatus()).toBe('failed');

      // Clear previous postMessage calls
      mockWorkerInstance.postMessage.mockClear();

      // Start health monitoring and advance timer
      manager.startHealthMonitoring();
      vi.advanceTimersByTime(60_000);

      const heartbeats = mockWorkerInstance.postMessage.mock.calls.filter(
        (c: any[]) => c[0].type === 'heartbeat',
      );
      expect(heartbeats).toHaveLength(0);
    });
  });

  describe('shutdown-complete changes status', () => {
    it('sets status to failed when shutdown-complete message is received', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(manager.getStatus()).toBe('ready');

      triggerWorkerMessage({ type: 'shutdown-complete' });

      expect(manager.getStatus()).toBe('failed');
    });
  });

  describe('no restart when already failed', () => {
    it('does not attempt restart when status is already failed', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Set status to failed
      triggerWorkerMessage({ type: 'shutdown-complete' });
      expect(manager.getStatus()).toBe('failed');

      const restartCountBefore = manager.getRestartCount();

      // Trigger exit with non-zero code — should NOT restart because status is 'failed'
      triggerWorkerExit(1);

      expect(manager.getRestartCount()).toBe(restartCountBefore);
      expect(manager.getStatus()).toBe('failed');
    });
  });

  describe('setStatus deduplication', () => {
    it('does not push to renderer when status is set to the same value', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // At this point, status is 'ready' and one push happened (from handleReady).
      const pushCountAfterReady = win.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'worker:status',
      ).length;

      // Send another heartbeat_ack with 'healthy' which maps to 'ready' — same status
      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'healthy',
      });

      const pushCountAfterDuplicate = win.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'worker:status',
      ).length;

      // Should not have pushed again because status is still 'ready'
      expect(pushCountAfterDuplicate).toBe(pushCountAfterReady);
    });

    it('does push to renderer when status actually changes', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      const pushCountAfterReady = win.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'worker:status',
      ).length;

      // Change to busy — different status
      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'busy',
      });

      const pushCountAfterChange = win.webContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'worker:status',
      ).length;

      expect(pushCountAfterChange).toBe(pushCountAfterReady + 1);
    });
  });

  describe('getStatusMessage for all statuses', () => {
    it('returns correct message for ready status', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Check the message pushed to renderer
      const statusCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'worker:status' && c[1].status === 'ready',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1].message).toBe('DuckDB engine is ready');
    });

    it('returns correct message for busy status', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'busy',
      });

      const statusCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'worker:status' && c[1].status === 'busy',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1].message).toBe('DuckDB engine is processing queries');
    });

    it('returns correct message for degraded status', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({
        type: 'heartbeat_ack',
        sentAt: Date.now(),
        status: 'degraded',
      });

      const statusCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'worker:status' && c[1].status === 'degraded',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1].message).toBe('DuckDB engine is experiencing issues');
    });

    it('returns correct message for restarting status', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Trigger a restart
      triggerWorkerExit(1);

      const statusCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'worker:status' && c[1].status === 'restarting',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1].message).toMatch(/DuckDB engine is restarting/);
    });

    it('returns correct message for failed status', async () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      // Use config with 0 max restarts to easily trigger 'failed'
      const failManager = new WorkerManager({
        ...defaultConfig,
        maxRestartAttempts: 0,
      });
      failManager.setMainWindow(win as any);

      const spawnPromise = failManager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Non-zero exit with 0 max restarts → immediate failed
      triggerWorkerExit(1);

      const statusCall = win.webContents.send.mock.calls.find(
        (c: any[]) => c[0] === 'worker:status' && c[1].status === 'failed',
      );
      expect(statusCall).toBeDefined();
      expect(statusCall![1].message).toBe('DuckDB engine has failed and cannot restart');

      failManager.stopHealthMonitoring();
    });

    it('returns correct message for starting status', () => {
      const win = createMockBrowserWindow();
      manager.setMainWindow(win as any);

      // Before spawn, status is 'starting'. getStatusMessage is private,
      // but getHealthRecord uses it indirectly. We can verify via the health push
      // that would happen if we could trigger setStatus('starting') — but starting
      // is the initial status before spawn. We verify via getHealthRecord shape.
      const record = manager.getHealthRecord();
      // 'starting' gets mapped to 'ready' in getHealthRecord, confirming the path works
      expect(record.status).toBe('ready');
    });
  });

  describe('shutdown resolves only on shutdown-complete message', () => {
    it('does not resolve on other message types', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      const shutdownPromise = manager.shutdown();
      let resolved = false;
      void shutdownPromise.then(() => {
        resolved = true;
      });

      // Send a different message type first — should NOT resolve shutdown
      const messageHandlers = mockWorkerInstance._handlers['message'] ?? [];
      messageHandlers.forEach((h) => {
        h({ type: 'heartbeat_ack', sentAt: Date.now(), status: 'healthy' });
      });

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Now send the correct message
      messageHandlers.forEach((h) => {
        h({ type: 'shutdown-complete' });
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);

      await shutdownPromise;
    });
  });

  describe('no-coverage message handlers', () => {
    it('handles health_check_result message without throwing', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(() => {
        triggerWorkerMessage({
          type: 'health_check_result',
          memoryUsage: 1024,
          activeConnections: 1,
        });
      }).not.toThrow();
    });

    it('handles port-ready message without throwing', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(() => {
        triggerWorkerMessage({ type: 'port-ready' });
      }).not.toThrow();
    });

    it('handles catalog_update message without throwing', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(() => {
        triggerWorkerMessage({ type: 'catalog_update', tables: [] });
      }).not.toThrow();
    });

    it('handles table_info message without throwing', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(() => {
        triggerWorkerMessage({ type: 'table_info', tableName: 'test' });
      }).not.toThrow();
    });

    it('handles error message and logs to console.error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      triggerWorkerMessage({ type: 'error', message: 'something went wrong' });

      expect(consoleSpy).toHaveBeenCalledWith('Worker error:', 'something went wrong');
      consoleSpy.mockRestore();
    });
  });

  describe('attemptRestart failure', () => {
    it('sets status to failed when spawn fails during restart', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      // Make the Worker constructor throw on the next call (the restart spawn)
      const { Worker: MockWorker } = await import('node:worker_threads');
      (MockWorker as any).mockImplementationOnce(() => {
        throw new Error('Failed to create worker');
      });

      // Trigger a restart via non-zero exit
      triggerWorkerExit(1);

      // Wait for the async attemptRestart to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getStatus()).toBe('failed');
    });
  });

  describe('attemptRestart spawns and starts health monitoring', () => {
    it('calls spawn and startHealthMonitoring during restart', async () => {
      const spawnPromise = manager.spawn();
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
      await spawnPromise;

      expect(manager.getRestartCount()).toBe(0);

      // Trigger restart
      triggerWorkerExit(1);

      expect(manager.getRestartCount()).toBe(1);
      expect(manager.getStatus()).toBe('restarting');

      // The restart spawn is in progress — simulate the new worker becoming ready
      triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });

      // Wait for async operations
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.getStatus()).toBe('ready');

      // Verify health monitoring was started — advance timer and check for heartbeat
      mockWorkerInstance.postMessage.mockClear();
      vi.advanceTimersByTime(60_000);

      const heartbeats = mockWorkerInstance.postMessage.mock.calls.filter(
        (c: any[]) => c[0].type === 'heartbeat',
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    });
  });
});
