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
    it('rejects table names containing double-quotes', async () => {
      // I6: strict identifier validation rejects quotes outright
      await expect(router.previewTable('my"table')).rejects.toThrow('Invalid table name');
    });

    it('rejects table names with multiple quotes', async () => {
      await expect(router.previewTable('a"b"c')).rejects.toThrow('Invalid table name');
    });

    it('falls back to default limit for negative limit', async () => {
      await router.previewTable('users', -1);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toBe('SELECT * FROM "users" LIMIT 10000');
    });

    it('falls back to default limit for NaN limit', async () => {
      await router.previewTable('users', NaN);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toBe('SELECT * FROM "users" LIMIT 10000');
    });

    it('clamps large limit to DEFAULT_PREVIEW_LIMIT', async () => {
      const result = await router.previewTable('users', 999999);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toBe('SELECT * FROM "users" LIMIT 10000');
      expect(result.effectiveLimit).toBe(10000);
      expect(result.wasClamped).toBe(true);
    });

    it('falls back to default limit for zero limit', async () => {
      const result = await router.previewTable('users', 0);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toBe('SELECT * FROM "users" LIMIT 10000');
      expect(result.effectiveLimit).toBe(10000);
      expect(result.wasClamped).toBe(false);
    });

    it('returns wasClamped false when limit is within range', async () => {
      const result = await router.previewTable('users', 500);

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toBe('SELECT * FROM "users" LIMIT 500');
      expect(result.effectiveLimit).toBe(500);
      expect(result.wasClamped).toBe(false);
    });

    it('returns wasClamped false when no limit provided', async () => {
      const result = await router.previewTable('users');

      const sql = (worker.postMessage.mock.calls[0]![0] as { sql: string }).sql;
      expect(sql).toBe('SELECT * FROM "users" LIMIT 10000');
      expect(result.effectiveLimit).toBe(10000);
      expect(result.wasClamped).toBe(false);
    });
  });
});
