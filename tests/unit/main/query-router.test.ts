import { QueryRouter } from '@main/query-router';
import { ERROR_CODES } from '@shared/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock crypto.randomUUID
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

function createMockWorker() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    postMessage: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
    }),
    removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    // Helper to simulate worker messages
    _emit(event: string, ...args: any[]) {
      listeners.get(event)?.forEach((h) => {
        h(...args);
      });
    },
    _listeners: listeners,
  };
}

function createMockBrowserWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('QueryRouter', () => {
  let worker: ReturnType<typeof createMockWorker>;
  let router: QueryRouter;
  let mainWindow: ReturnType<typeof createMockBrowserWindow>;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = createMockWorker();
    router = new QueryRouter(worker as any);
    mainWindow = createMockBrowserWindow();
    router.setMainWindow(mainWindow as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('executeQuery', () => {
    it('returns a query handle with UUID', async () => {
      const handle = await router.executeQuery('SELECT 1');
      expect(handle.queryId).toBe('test-uuid-1234');
    });

    it('sends execute message to worker', async () => {
      await router.executeQuery('SELECT * FROM users', ['param1']);

      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'execute_query',
          queryId: 'test-uuid-1234',
          sql: 'SELECT * FROM users',
          params: ['param1'],
        }),
      );
    });

    it('pushes scanning status to renderer', async () => {
      await router.executeQuery('SELECT 1');

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'query:progress',
        expect.objectContaining({
          queryId: 'test-uuid-1234',
          phase: 'scanning',
          batchesStreamed: 0,
          elapsedMs: 0,
        }),
      );
    });

    it('throws when shutting down', async () => {
      router.beginShutdown();

      await expect(router.executeQuery('SELECT 1')).rejects.toMatchObject({
        code: ERROR_CODES.SHUTTING_DOWN,
      });
    });

    it('auto-cancels query after timeout', async () => {
      await router.executeQuery('SELECT 1');

      // Advance past default timeout (30s)
      vi.advanceTimersByTime(31_000);

      // Should have sent cancel message
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cancel_query',
          queryId: 'test-uuid-1234',
        }),
      );
    });
  });

  describe('cancelQuery', () => {
    it('sends cancel message to worker', async () => {
      await router.executeQuery('SELECT 1');
      await router.cancelQuery('test-uuid-1234');

      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'cancel_query',
        queryId: 'test-uuid-1234',
      });
    });

    it('clears timeout for cancelled query', async () => {
      await router.executeQuery('SELECT 1');
      await router.cancelQuery('test-uuid-1234');

      // Advance past timeout — should NOT send another cancel
      worker.postMessage.mockClear();
      vi.advanceTimersByTime(31_000);

      // Only the cancel we already sent, not another one from timeout
      const cancelCalls = worker.postMessage.mock.calls.filter(
        (call) => call[0].type === 'cancel_query',
      );
      expect(cancelCalls).toHaveLength(0);
    });

    it('handles cancelling non-existent query', async () => {
      // Should not throw
      await router.cancelQuery('nonexistent');
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: 'cancel_query',
        queryId: 'nonexistent',
      });
    });
  });

  describe('listTables', () => {
    it('resolves with table list from worker', async () => {
      const tables = [
        {
          id: '1',
          name: 'users',
          schema: 'main',
          type: 'table' as const,
          status: 'active' as const,
          rowCount: 100,
          sizeBytes: 1024,
          columnCount: 3,
          registeredAt: '',
        },
      ];

      const promise = router.listTables();

      // Simulate worker response
      worker._emit('message', { type: 'table_list', tables });

      const result = await promise;
      expect(result).toEqual(tables);
    });

    it('rejects on worker error', async () => {
      const promise = router.listTables();

      worker._emit('message', { type: 'error', message: 'DB locked' });

      await expect(promise).rejects.toThrow('DB locked');
    });

    it('rejects on timeout', async () => {
      const promise = router.listTables();

      vi.advanceTimersByTime(31_000);

      await expect(promise).rejects.toThrow('Timeout');
    });

    it('ignores non-matching message types and still resolves on table_list', async () => {
      // Kills: else if (msg.type === 'error') → else if (true) on line 139
      // If mutated to 'true', a non-error/non-table_list message would be
      // caught by the error branch and reject the promise prematurely.
      const tables = [
        {
          id: '1',
          name: 'test',
          schema: 'main',
          type: 'table' as const,
          status: 'active' as const,
          rowCount: 10,
          sizeBytes: 100,
          columnCount: 1,
          registeredAt: '',
        },
      ];

      const promise = router.listTables();

      // Send a non-matching message type first (e.g., 'health_check')
      worker._emit('message', { type: 'health_check', status: 'ok' });

      // Then send the correct table_list response
      worker._emit('message', { type: 'table_list', tables });

      const result = await promise;
      expect(result).toEqual(tables);
    });
  });

  describe('describeTable', () => {
    it('resolves with column schemas', async () => {
      const columns = [
        {
          name: 'id',
          duckdbType: 'INTEGER',
          arrowType: 'Int32',
          nullable: false,
          ordinalPosition: 0,
        },
        {
          name: 'name',
          duckdbType: 'VARCHAR',
          arrowType: 'Utf8',
          nullable: true,
          ordinalPosition: 1,
        },
      ];

      const promise = router.describeTable('users');

      worker._emit('message', { type: 'table_info', tableName: 'users', columns });

      const result = await promise;
      expect(result).toEqual(columns);
    });

    it('ignores table_info for different table', async () => {
      const promise = router.describeTable('users');

      // Send info for wrong table first
      worker._emit('message', {
        type: 'table_info',
        tableName: 'orders',
        columns: [{ name: 'id' }],
      });

      // Then send correct table
      const columns = [
        {
          name: 'id',
          duckdbType: 'INTEGER',
          arrowType: 'Int32',
          nullable: false,
          ordinalPosition: 0,
        },
      ];
      worker._emit('message', { type: 'table_info', tableName: 'users', columns });

      const result = await promise;
      expect(result).toEqual(columns);
    });

    it('rejects on worker error', async () => {
      const promise = router.describeTable('users');

      worker._emit('message', { type: 'error', message: 'Table not found' });

      await expect(promise).rejects.toThrow('Table not found');
    });

    it('rejects with error when error message has matching tableName', async () => {
      // Kills: msg.type === 'table_info' → true on line 171
      // If mutated to 'true', an error message with matching tableName would
      // resolve instead of reject (since the first branch catches everything).
      const promise = router.describeTable('users');

      worker._emit('message', {
        type: 'error',
        tableName: 'users',
        message: 'Permission denied',
      });

      await expect(promise).rejects.toThrow('Permission denied');
    });
  });

  describe('previewTable', () => {
    it('executes SELECT * with default limit 100', async () => {
      await router.previewTable('users');

      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'execute_query',
          sql: 'SELECT * FROM "users" LIMIT 100',
        }),
      );
    });

    it('respects custom limit', async () => {
      await router.previewTable('users', 50);

      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: 'SELECT * FROM "users" LIMIT 50',
        }),
      );
    });

    // I6: Strict identifier validation
    it('rejects table names with SQL injection characters', async () => {
      await expect(router.previewTable('users"; DROP TABLE users;--')).rejects.toThrow(
        'Invalid table name',
      );
    });

    it('rejects table names with semicolons', async () => {
      await expect(router.previewTable('users;')).rejects.toThrow('Invalid table name');
    });

    it('rejects table names with quotes', async () => {
      await expect(router.previewTable('users"')).rejects.toThrow('Invalid table name');
    });

    it('accepts valid identifiers with underscores and dots', async () => {
      await router.previewTable('schema.my_table');
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: 'SELECT * FROM "schema.my_table" LIMIT 100',
        }),
      );
    });
  });

  describe('queryCompleted', () => {
    it('clears timeout and removes from active queries', async () => {
      await router.executeQuery('SELECT 1');
      router.queryCompleted('test-uuid-1234');

      // Advance past timeout — no cancel should be sent
      worker.postMessage.mockClear();
      vi.advanceTimersByTime(31_000);

      const cancelCalls = worker.postMessage.mock.calls.filter(
        (call) => call[0].type === 'cancel_query',
      );
      expect(cancelCalls).toHaveLength(0);
    });

    it('handles completing non-existent query gracefully', () => {
      // Should not throw
      router.queryCompleted('nonexistent');
    });
  });

  describe('beginShutdown', () => {
    it('cancels all active queries', async () => {
      // Override randomUUID to return different IDs
      const crypto = await import('node:crypto');
      vi.mocked(crypto.randomUUID)
        .mockImplementationOnce(() => 'q1' as any)
        .mockImplementationOnce(() => 'q2' as any);

      await router.executeQuery('SELECT 1');
      await router.executeQuery('SELECT 2');

      worker.postMessage.mockClear();
      router.beginShutdown();

      const cancelCalls = worker.postMessage.mock.calls.filter(
        (call) => call[0].type === 'cancel_query',
      );
      expect(cancelCalls).toHaveLength(2);
    });

    it('prevents new queries after shutdown begins', async () => {
      router.beginShutdown();

      await expect(router.executeQuery('SELECT 1')).rejects.toBeDefined();
    });
  });

  describe('setWorker', () => {
    it('replaces the worker reference', async () => {
      const newWorker = createMockWorker();
      router.setWorker(newWorker as any);

      await router.executeQuery('SELECT 1');

      expect(newWorker.postMessage).toHaveBeenCalled();
      expect(worker.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('status push', () => {
    it('does not push when window is destroyed', async () => {
      mainWindow.isDestroyed.mockReturnValue(true);

      await router.executeQuery('SELECT 1');

      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('does not push when no main window set', async () => {
      const routerNoWindow = new QueryRouter(worker as any);

      // Should not throw
      await routerNoWindow.executeQuery('SELECT 1');
    });
  });
});
