import { QueryRouter } from '@main/query-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    _emit(event: string, ...args: any[]) {
      listeners.get(event)?.forEach((h) => {
        h(...args);
      });
    },
  };
}

describe('QueryRouter — Regression', () => {
  let worker: ReturnType<typeof createMockWorker>;
  let router: QueryRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = createMockWorker();
    router = new QueryRouter(worker as any);
    router.setMainWindow({
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // #12: SQL injection in previewTable
  describe('previewTable SQL injection protection (#12)', () => {
    it('escapes double-quotes in table name', async () => {
      await router.previewTable('my"table');

      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'execute_query',
          sql: expect.stringContaining('my""table'),
        }),
      );

      // Should NOT contain an unescaped single double-quote
      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      // The table name should be properly escaped: "my""table"
      expect(sql).toContain('"my""table"');
    });

    it('handles table name with multiple quotes', async () => {
      await router.previewTable('a"b"c');

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toContain('"a""b""c"');
    });

    it('uses default limit of 100 for negative limit', async () => {
      await router.previewTable('users', -1);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toMatch(/LIMIT 100$/);
    });

    it('uses default limit of 100 for NaN limit', async () => {
      await router.previewTable('users', NaN);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toMatch(/LIMIT 100$/);
    });

    it('clamps excessively large limit to 10000', async () => {
      await router.previewTable('users', 999999);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toMatch(/LIMIT 10000$/);
    });

    it('uses default limit of 100 for zero limit', async () => {
      await router.previewTable('users', 0);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toMatch(/LIMIT 100$/);
    });
  });
});
