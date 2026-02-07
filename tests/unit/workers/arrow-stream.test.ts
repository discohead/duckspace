import { ArrowStream } from '@workers/arrow-stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockPort() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  const port: any = {
    postMessage: vi.fn(),
    on(event: string, handler: (...args: any[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
      return port;
    },
    _listeners: listeners,
  };
  return port;
}

function simulateMessage(port: any, data: any) {
  const handlers = port._listeners.get('message') ?? [];
  for (const handler of handlers) {
    handler(data);
  }
}

function createMockConnection(rows: any[][] = []) {
  return {
    run: vi.fn().mockResolvedValue({
      getRows: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('ArrowStream', () => {
  let stream: ArrowStream;
  let port: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    stream = new ArrowStream();
    port = createMockPort();
  });

  describe('setDataPort', () => {
    it('sets up message handler on port', () => {
      stream.setDataPort(port);
      const handlers = port._listeners.get('message') ?? [];
      expect(handlers.length).toBeGreaterThan(0);
    });
  });

  describe('ACK handling', () => {
    it('processes ack messages', () => {
      stream.setDataPort(port);

      // Should not throw
      simulateMessage(port, { type: 'ack', queryId: 'q1', index: 0 });
    });

    it('processes cancel messages', () => {
      stream.setDataPort(port);

      simulateMessage(port, { type: 'cancel', queryId: 'q1' });
      // Query should be marked as cancelled internally
    });

    it('ignores invalid messages', () => {
      stream.setDataPort(port);

      // Should not throw
      simulateMessage(port, null);
      simulateMessage(port, 'string');
      simulateMessage(port, { type: 'unknown' });
    });
  });

  describe('cancelQuery', () => {
    it('marks query as cancelled', () => {
      stream.cancelQuery('q1');
      // Internally cancelled — verified by streamQuery returning early
    });
  });

  describe('streamQuery', () => {
    it('sends end message for empty results', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([]);

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      expect(result.totalRows).toBe(0);
      expect(result.totalBatches).toBe(0);
      expect(result.totalBytes).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Should send arrow-end
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-end',
          queryId: 'q1',
          totalBatches: 0,
        }),
      );
    });

    it('sends end message for null result row', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([[null]]);

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      expect(result.totalBatches).toBe(0);
    });

    it('sends batch and end for results with data', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([1, 2, 3, 4]);
      const conn = createMockConnection([[ipcBuffer]]);

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      expect(result.totalBatches).toBe(1);
      expect(result.totalBytes).toBe(4);

      // Should send arrow-batch then arrow-end
      const calls = port.postMessage.mock.calls;
      const batchCall = calls.find((c: any) => c[0].type === 'arrow-batch');
      const endCall = calls.find((c: any) => c[0].type === 'arrow-end');

      expect(batchCall).toBeDefined();
      expect(batchCall?.[0].queryId).toBe('q1');
      expect(batchCall?.[0].byteSize).toBe(4);
      expect(endCall).toBeDefined();
    });

    it('wraps SQL with to_arrow_ipc', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([]);

      await stream.streamQuery(conn, 'q1', 'SELECT * FROM users');

      expect(conn.run).toHaveBeenCalledWith('SELECT * FROM to_arrow_ipc((SELECT * FROM users))');
    });

    it('passes params when provided', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([]);

      await stream.streamQuery(conn, 'q1', 'SELECT $1', ['hello']);

      expect(conn.run).toHaveBeenCalledWith('SELECT * FROM to_arrow_ipc((SELECT $1))', ['hello']);
    });

    it('returns early for pre-cancelled queries', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([[new Uint8Array([1, 2, 3])]]);

      stream.cancelQuery('q1');
      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      expect(result.totalBatches).toBe(0);
      expect(conn.run).not.toHaveBeenCalled();
    });

    it('handles cancellation after query execution', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockImplementation(async () => {
          // Cancel during execution
          stream.cancelQuery('q1');
          return { getRows: vi.fn().mockResolvedValue([[new Uint8Array([1])]]) };
        }),
      };

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');
      expect(result.totalBatches).toBe(0);
    });

    it('sends error on query failure', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('syntax error in SQL')),
      };

      await expect(stream.streamQuery(conn, 'q1', 'SELEC 1')).rejects.toThrow('syntax error');

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          queryId: 'q1',
          code: 'E1001',
        }),
      );
    });

    it('classifies out of memory errors', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Out of Memory: allocation failed')),
      };

      await expect(stream.streamQuery(conn, 'q1', 'SELECT *')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1007',
        }),
      );
    });

    it('classifies table not found errors', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Table "foo" does not exist')),
      };

      await expect(stream.streamQuery(conn, 'q1', 'SELECT * FROM foo')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1004',
        }),
      );
    });

    it('does not send batch when no port set', async () => {
      // No port set
      const conn = createMockConnection([[new Uint8Array([1, 2])]]);
      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      // Should still complete but not post any messages
      expect(result.totalBatches).toBe(1);
    });
  });
});
