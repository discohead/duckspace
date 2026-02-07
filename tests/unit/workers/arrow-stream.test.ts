import { BACKPRESSURE } from '@shared/constants';
import { ArrowStream } from '@workers/arrow-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  } as any; // Partial mock of DuckDBConnection
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
      } as any;

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');
      expect(result.totalBatches).toBe(0);
    });

    it('sends error on query failure', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('syntax error in SQL')),
      } as any;

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
      } as any;

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
      } as any;

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

  describe('handleAck internal state changes', () => {
    it('ACK for a pending batch removes it from pendingAcks', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([10, 20, 30]);
      const conn = createMockConnection([[ipcBuffer]]);

      // Stream a query — this creates a pending ACK for index 0
      await stream.streamQuery(conn, 'q1', 'SELECT 1');

      // Verify the batch was sent
      const batchCall = port.postMessage.mock.calls.find((c: any) => c[0].type === 'arrow-batch');
      expect(batchCall).toBeDefined();
      expect(batchCall?.[0].queryId).toBe('q1');

      // Now send an ACK for that batch
      simulateMessage(port, { type: 'ack', queryId: 'q1', index: 0 });

      // To verify the ACK was processed: a subsequent streamQuery for the same
      // queryId should work without being blocked by old pending ACKs
      const conn2 = createMockConnection([[new Uint8Array([40, 50])]]);
      const result2 = await stream.streamQuery(conn2, 'q1', 'SELECT 2');
      expect(result2.totalBatches).toBe(1);
    });

    it('cancel message via data port marks query as cancelled', async () => {
      stream.setDataPort(port);

      // Send cancel through the data port message handler
      simulateMessage(port, { type: 'cancel', queryId: 'q-cancel-test' });

      // Verify the cancellation by attempting to stream — it should return early
      const conn = createMockConnection([[new Uint8Array([1, 2, 3])]]);
      const result = await stream.streamQuery(conn, 'q-cancel-test', 'SELECT 1');

      expect(result.totalBatches).toBe(0);
      expect(result.totalBytes).toBe(0);
      // connection.run should NOT be called because the query was pre-cancelled
      expect(conn.run).not.toHaveBeenCalled();
    });

    it('cancel message without queryId does not cancel anything', async () => {
      stream.setDataPort(port);

      // Send a cancel with no queryId — the if(queryId) guard should prevent action
      simulateMessage(port, { type: 'cancel' });
      simulateMessage(port, { type: 'cancel', queryId: '' });

      // Streaming an arbitrary query should still work (not cancelled)
      const conn = createMockConnection([[new Uint8Array([1])]]);
      const result = await stream.streamQuery(conn, 'q-ok', 'SELECT 1');
      expect(result.totalBatches).toBe(1);
    });

    it('ACK cleanup removes queryId entry when all batches are acked', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([1, 2, 3, 4]);
      const conn = createMockConnection([[ipcBuffer]]);

      await stream.streamQuery(conn, 'q-ack-cleanup', 'SELECT 1');

      // ACK the single batch
      simulateMessage(port, { type: 'ack', queryId: 'q-ack-cleanup', index: 0 });

      // Verify cleanup by running another query on same queryId — no stale state
      const conn2 = createMockConnection([[new Uint8Array([5, 6])]]);
      const result = await stream.streamQuery(conn2, 'q-ack-cleanup', 'SELECT 2');
      expect(result.totalBatches).toBe(1);
    });

    it('typeof guard rejects non-object messages', () => {
      stream.setDataPort(port);

      // These should be silently ignored (typeof !== 'object')
      simulateMessage(port, 42);
      simulateMessage(port, true);
      simulateMessage(port, undefined);
      simulateMessage(port, null);
      simulateMessage(port, 'not-an-object');

      // No crash, and port.postMessage not called (no side effects)
      expect(port.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('classifyErrorCode all branches', () => {
    it('classifies "column does not exist" as E1005', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Referenced column "xyz" does not exist')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'SELECT xyz FROM t')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1005',
        }),
      );
    });

    it('classifies "type mismatch" as E1006', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi
          .fn()
          .mockRejectedValue(new Error('Type mismatch: expected INTEGER but got VARCHAR')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'SELECT 1')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1006',
        }),
      );
    });

    it('classifies "parser error" as E1001', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Parser Error: unexpected token')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'INVALID SQL')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1001',
        }),
      );
    });

    it('classifies "memory limit" as E1007', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Memory limit exceeded: cannot allocate')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'SELECT *')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1007',
        }),
      );
    });

    it('classifies unknown errors as E1001 (default)', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Something completely unexpected')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'SELECT 1')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1001',
        }),
      );
    });

    it('classifies "syntax error" without "parser error" as E1001', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('syntax error at or near "SELEC"')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'SELEC 1')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1001',
        }),
      );
    });

    it('classifies "does not exist" without "table" or "column" as E1001', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockRejectedValue(new Error('Function "foo" does not exist')),
      } as any;

      await expect(stream.streamQuery(conn, 'q1', 'SELECT foo()')).rejects.toThrow();

      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'arrow-error',
          code: 'E1001',
        }),
      );
    });
  });

  describe('streamQuery with empty params array', () => {
    it('does not pass params to connection.run when params is empty array', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([]);

      await stream.streamQuery(conn, 'q1', 'SELECT 1', []);

      // With empty params [], the condition `params.length > 0` is false,
      // so run should be called WITHOUT params (single argument)
      expect(conn.run).toHaveBeenCalledTimes(1);
      expect(conn.run).toHaveBeenCalledWith('SELECT * FROM to_arrow_ipc((SELECT 1))');
    });

    it('does not pass params when params is undefined', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([]);

      await stream.streamQuery(conn, 'q1', 'SELECT 1', undefined);

      expect(conn.run).toHaveBeenCalledTimes(1);
      expect(conn.run).toHaveBeenCalledWith('SELECT * FROM to_arrow_ipc((SELECT 1))');
    });
  });

  describe('durationMs calculation', () => {
    it('returns non-negative durationMs for empty results', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([]);

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      // durationMs must be >= 0; a `+ startMs` mutation would produce enormous values
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it('returns non-negative durationMs for results with data', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([[new Uint8Array([1, 2, 3])]]);

      const result = await stream.streamQuery(conn, 'q1', 'SELECT 1');

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it('returns non-negative durationMs for pre-cancelled queries', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([[new Uint8Array([1])]]);

      stream.cancelQuery('q-dur');
      const result = await stream.streamQuery(conn, 'q-dur', 'SELECT 1');

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it('returns non-negative durationMs for post-execution cancelled queries', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockImplementation(async () => {
          stream.cancelQuery('q-dur2');
          return { getRows: vi.fn().mockResolvedValue([[new Uint8Array([1])]]) };
        }),
      } as any;

      const result = await stream.streamQuery(conn, 'q-dur2', 'SELECT 1');

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.durationMs).toBeLessThan(5000);
    });

    it('sendEnd receives non-negative durationMs', async () => {
      stream.setDataPort(port);
      const conn = createMockConnection([[new Uint8Array([1, 2])]]);

      await stream.streamQuery(conn, 'q1', 'SELECT 1');

      const endCall = port.postMessage.mock.calls.find((c: any) => c[0].type === 'arrow-end');
      expect(endCall).toBeDefined();
      expect(endCall?.[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(endCall?.[0].durationMs).toBeLessThan(5000);
    });
  });

  describe('backpressure window', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits when pending ACKs fill the window then unblocks on ACK', async () => {
      stream.setDataPort(port);

      // Manually fill the pending ACKs to WINDOW_SIZE for queryId 'q-bp'
      // We access internal state by sending batches and NOT acking them.
      // Simpler approach: stream one query, don't ACK, then try another query
      // that blocks on waitForWindow.

      // First, stream a query that produces data. This adds 1 pending ACK.
      // We need to fill WINDOW_SIZE pending ACKs. Since each streamQuery call
      // adds 1 pending ACK (index 0), and sendEnd cleans up, we need a different
      // approach. Let's manipulate the internal state by accessing pendingAcks
      // indirectly: send multiple batch messages without ACKs.

      // Actually, sendEnd clears pendingAcks. So we can't easily fill via streamQuery.
      // Instead, we use a custom approach: mock the first streamQuery to NOT send
      // end (by cancelling after sendBatch but before sendEnd is unreachable).

      // Best approach: Use the data port to fill pending acks directly is not possible.
      // Instead, let's do: start a query that will block on waitForWindow because
      // we pre-filled pendingAcks through the internal handleAck mechanism.

      // Simplest: cast stream to any and set pendingAcks directly
      const streamAny = stream as any;
      const pending = new Set<number>();
      for (let i = 0; i < BACKPRESSURE.WINDOW_SIZE; i++) {
        pending.add(i);
      }
      streamAny.pendingAcks.set('q-bp', pending);

      // Start streaming — it will block in waitForWindow
      const conn = createMockConnection([[new Uint8Array([10, 20])]]);
      let resolved = false;
      const streamPromise = stream.streamQuery(conn, 'q-bp', 'SELECT 1').then((r) => {
        resolved = true;
        return r;
      });

      // Advance timers to trigger the ACK_POLL_INTERVAL_MS check
      await vi.advanceTimersByTimeAsync(20);
      expect(resolved).toBe(false); // Still blocked

      // Simulate ACK to reduce pending below WINDOW_SIZE
      simulateMessage(port, { type: 'ack', queryId: 'q-bp', index: 0 });

      // Advance timers so the poll loop picks up the change
      await vi.advanceTimersByTimeAsync(20);

      const result = await streamPromise;
      expect(resolved).toBe(true);
      expect(result.totalBatches).toBe(1);
    });

    it('returns false from waitForWindow when cancelled during wait', async () => {
      stream.setDataPort(port);

      // Fill pending ACKs to block the window
      const streamAny = stream as any;
      const pending = new Set<number>();
      for (let i = 0; i < BACKPRESSURE.WINDOW_SIZE; i++) {
        pending.add(i);
      }
      streamAny.pendingAcks.set('q-cancel-wait', pending);

      const conn = createMockConnection([[new Uint8Array([1, 2, 3])]]);
      let resolved = false;
      const streamPromise = stream.streamQuery(conn, 'q-cancel-wait', 'SELECT 1').then((r) => {
        resolved = true;
        return r;
      });

      // Advance timers but don't ACK — instead cancel
      await vi.advanceTimersByTimeAsync(20);
      expect(resolved).toBe(false);

      // Cancel the query while it's waiting in waitForWindow
      stream.cancelQuery('q-cancel-wait');

      // Advance timers so the poll loop picks up the cancellation
      await vi.advanceTimersByTimeAsync(20);

      const result = await streamPromise;
      expect(resolved).toBe(true);
      // Since waitForWindow returned false, batches should not be sent
      expect(result.totalBatches).toBe(0);
    });

    it('proceeds immediately when inflight count is below WINDOW_SIZE', async () => {
      stream.setDataPort(port);

      // No pending ACKs — window is fully open
      const conn = createMockConnection([[new Uint8Array([5, 6, 7])]]);
      const result = await stream.streamQuery(conn, 'q-fast', 'SELECT 1');

      expect(result.totalBatches).toBe(1);
      expect(result.totalBytes).toBe(3);
    });
  });

  describe('sendBatch transfer array', () => {
    it('transfers the buffer in the transfer list', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([10, 20, 30, 40, 50]);
      const conn = createMockConnection([[ipcBuffer]]);

      await stream.streamQuery(conn, 'q1', 'SELECT 1');

      const batchCall = port.postMessage.mock.calls.find((c: any) => c[0].type === 'arrow-batch');
      expect(batchCall).toBeDefined();

      // Second argument to postMessage is the transfer list
      const transferList = batchCall?.[1];
      expect(transferList).toBeDefined();
      expect(Array.isArray(transferList)).toBe(true);
      expect(transferList).toHaveLength(1);
      // The transferred item should be an ArrayBuffer
      expect(transferList?.[0]).toBeInstanceOf(ArrayBuffer);
      expect(transferList?.[0].byteLength).toBe(5);
    });

    it('sends batch message with buffer property', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([1, 2]);
      const conn = createMockConnection([[ipcBuffer]]);

      await stream.streamQuery(conn, 'q1', 'SELECT 1');

      const batchCall = port.postMessage.mock.calls.find((c: any) => c[0].type === 'arrow-batch');
      expect(batchCall).toBeDefined();
      // The message includes the buffer property (spread via ...msg, buffer)
      expect(batchCall?.[0].buffer).toBeInstanceOf(ArrayBuffer);
    });
  });

  describe('pending ACK tracking in sendBatch', () => {
    it('populates pendingAcks after sending a batch', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([1, 2, 3]);
      const conn = createMockConnection([[ipcBuffer]]);

      // Access internal state to verify
      const streamAny = stream as any;

      // Before streaming, no pending ACKs
      expect(streamAny.pendingAcks.size).toBe(0);

      // We need to intercept the state AFTER sendBatch but BEFORE sendEnd
      // (since sendEnd clears pendingAcks). We do this by mocking postMessage
      // to capture state at the right moment.
      let pendingAtBatchTime: number | undefined;
      port.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'arrow-batch') {
          // Capture pending state right after sendBatch sets it
          const pending = streamAny.pendingAcks.get('q-track');
          pendingAtBatchTime = pending?.size;
        }
      });

      await stream.streamQuery(conn, 'q-track', 'SELECT 1');

      // At the time of sending the batch, there should be 1 pending ACK
      expect(pendingAtBatchTime).toBe(1);
    });

    it('creates new Set for queryId when first batch is sent', async () => {
      stream.setDataPort(port);
      const ipcBuffer = new Uint8Array([1]);
      const conn = createMockConnection([[ipcBuffer]]);

      const streamAny = stream as any;
      let pendingSetExisted = false;

      port.postMessage.mockImplementation((msg: any) => {
        if (msg.type === 'arrow-batch') {
          const pending = streamAny.pendingAcks.get('q-new-set');
          pendingSetExisted = pending instanceof Set;
        }
      });

      await stream.streamQuery(conn, 'q-new-set', 'SELECT 1');

      expect(pendingSetExisted).toBe(true);
    });

    it('ACK removes batch index from pending set', async () => {
      stream.setDataPort(port);
      const streamAny = stream as any;

      // Manually set up a pending ACK
      streamAny.pendingAcks.set('q-ack-rm', new Set([0, 1, 2]));

      // ACK batch index 1
      simulateMessage(port, { type: 'ack', queryId: 'q-ack-rm', index: 1 });

      const pending = streamAny.pendingAcks.get('q-ack-rm');
      expect(pending).toBeDefined();
      expect(pending.has(0)).toBe(true);
      expect(pending.has(1)).toBe(false); // removed by ACK
      expect(pending.has(2)).toBe(true);
    });

    it('ACK removes queryId entry when last batch is acked', async () => {
      stream.setDataPort(port);
      const streamAny = stream as any;

      // Set up pending with a single batch
      streamAny.pendingAcks.set('q-last', new Set([0]));

      // ACK the only remaining batch
      simulateMessage(port, { type: 'ack', queryId: 'q-last', index: 0 });

      // The entire queryId entry should be removed
      expect(streamAny.pendingAcks.has('q-last')).toBe(false);
    });
  });

  describe('sendEnd and sendError cleanup', () => {
    it('sendEnd cleans up pendingAcks for the query', async () => {
      stream.setDataPort(port);
      const streamAny = stream as any;

      // Pre-populate some pending ACKs for the query
      streamAny.pendingAcks.set('q-end-clean', new Set([0, 1]));

      const conn = createMockConnection([]);
      await stream.streamQuery(conn, 'q-end-clean', 'SELECT 1');

      // After streamQuery (which calls sendEnd), pending should be cleaned up
      expect(streamAny.pendingAcks.has('q-end-clean')).toBe(false);
    });

    it('sendEnd cleans up cancelled set for the query', async () => {
      stream.setDataPort(port);
      const streamAny = stream as any;

      // Pre-cancel a query, then stream it (it will return early and call sendEnd)
      stream.cancelQuery('q-end-cancel');
      expect(streamAny.cancelled.has('q-end-cancel')).toBe(true);

      const conn = createMockConnection([]);
      await stream.streamQuery(conn, 'q-end-cancel', 'SELECT 1');

      // After sendEnd, the cancelled set should be cleaned up
      expect(streamAny.cancelled.has('q-end-cancel')).toBe(false);
    });

    it('sendError cleans up pendingAcks for the query', async () => {
      stream.setDataPort(port);
      const streamAny = stream as any;

      // Pre-populate pending ACKs
      streamAny.pendingAcks.set('q-err-clean', new Set([0]));

      const conn = {
        run: vi.fn().mockRejectedValue(new Error('some error')),
      } as any;

      await expect(stream.streamQuery(conn, 'q-err-clean', 'SELECT 1')).rejects.toThrow();

      // After sendError, pending should be cleaned up
      expect(streamAny.pendingAcks.has('q-err-clean')).toBe(false);
    });

    it('sendError cleans up cancelled set for the query', async () => {
      stream.setDataPort(port);
      const streamAny = stream as any;

      // Don't pre-cancel — instead, make the query fail, then check that
      // sendError cleans up the cancelled set. We add to cancelled AFTER
      // the pre-cancellation check runs by doing it inside the mock.
      const conn = {
        run: vi.fn().mockImplementation(async () => {
          // Add to cancelled during execution (after pre-cancel check)
          streamAny.cancelled.add('q-err-cancel');
          throw new Error('query failed');
        }),
      } as any;

      await expect(stream.streamQuery(conn, 'q-err-cancel', 'SELECT 1')).rejects.toThrow();

      // After sendError, cancelled should be cleaned up
      expect(streamAny.cancelled.has('q-err-cancel')).toBe(false);
    });
  });

  describe('post-execution cancellation sends end message', () => {
    it('sends arrow-end with zero batches when cancelled after execution', async () => {
      stream.setDataPort(port);
      const conn = {
        run: vi.fn().mockImplementation(async () => {
          stream.cancelQuery('q-post-cancel');
          return {
            getRows: vi.fn().mockResolvedValue([[new Uint8Array([1, 2])]]),
          };
        }),
      } as any;

      const result = await stream.streamQuery(conn, 'q-post-cancel', 'SELECT 1');

      expect(result.totalBatches).toBe(0);
      expect(result.totalBytes).toBe(0);

      // Verify sendEnd was called with zeros
      const endCall = port.postMessage.mock.calls.find((c: any) => c[0].type === 'arrow-end');
      expect(endCall).toBeDefined();
      expect(endCall?.[0].totalBatches).toBe(0);
      expect(endCall?.[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(endCall?.[0].durationMs).toBeLessThan(5000);
    });
  });
});
