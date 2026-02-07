import { BackpressureManager } from '@renderer/lib/backpressure';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockPort() {
  const port: any = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    start: vi.fn(),
  };
  return port;
}

function simulateMessage(port: any, data: any) {
  port.onmessage({ data } as MessageEvent);
}

describe('BackpressureManager', () => {
  let manager: BackpressureManager;
  let port: any;

  beforeEach(() => {
    manager = new BackpressureManager();
    port = createMockPort();
  });

  describe('setPort', () => {
    it('sets up message handler and starts port', () => {
      manager.setPort(port);

      expect(port.onmessage).toBeTypeOf('function');
      expect(port.start).toHaveBeenCalled();
    });
  });

  describe('onData', () => {
    it('registers batch callback and returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsub = manager.onData('q1', callback);

      expect(typeof unsub).toBe('function');
    });

    it('calls callback when batch message arrives', () => {
      manager.setPort(port);
      const callback = vi.fn();
      manager.onData('q1', callback);

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 100,
        byteSize: 1024,
        buffer: new ArrayBuffer(1024),
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 0,
          rowCount: 100,
          byteSize: 1024,
          isLast: false,
        }),
      );
    });

    it('sends ACK back on batch receipt', () => {
      manager.setPort(port);
      manager.onData('q1', vi.fn());

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 2,
        rowCount: 50,
        byteSize: 512,
        buffer: new ArrayBuffer(512),
      });

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'ack',
        queryId: 'q1',
        index: 2,
      });
    });

    it('unsubscribe prevents further callbacks', () => {
      manager.setPort(port);
      const callback = vi.fn();
      const unsub = manager.onData('q1', callback);

      unsub();

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 10,
        byteSize: 100,
        buffer: new ArrayBuffer(100),
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onEnd', () => {
    it('calls callback with stream summary', () => {
      manager.setPort(port);
      const callback = vi.fn();
      manager.onEnd('q1', callback);

      simulateMessage(port, {
        type: 'arrow-end',
        queryId: 'q1',
        totalBatches: 5,
        totalRows: 500,
        totalBytes: 5120,
        durationMs: 150,
      });

      expect(callback).toHaveBeenCalledWith({
        queryId: 'q1',
        totalRows: 500,
        totalBatches: 5,
        totalBytes: 5120,
        durationMs: 150,
      });
    });

    it('cleans up all callbacks for query after end', () => {
      manager.setPort(port);
      const batchCb = vi.fn();
      const endCb = vi.fn();
      const errorCb = vi.fn();

      manager.onData('q1', batchCb);
      manager.onEnd('q1', endCb);
      manager.onError('q1', errorCb);

      // Trigger end
      simulateMessage(port, {
        type: 'arrow-end',
        queryId: 'q1',
        totalBatches: 1,
        totalRows: 10,
        totalBytes: 100,
        durationMs: 5,
      });

      // Subsequent messages should not trigger callbacks
      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 10,
        byteSize: 100,
        buffer: new ArrayBuffer(100),
      });

      expect(batchCb).not.toHaveBeenCalled();
    });
  });

  describe('onError', () => {
    it('calls callback with error info', () => {
      manager.setPort(port);
      const callback = vi.fn();
      manager.onError('q1', callback);

      simulateMessage(port, {
        type: 'arrow-error',
        queryId: 'q1',
        code: 'E1001',
        message: 'syntax error',
        batchesSent: 0,
      });

      expect(callback).toHaveBeenCalledWith({
        queryId: 'q1',
        code: 'E1001',
        message: 'syntax error',
      });
    });

    it('cleans up callbacks after error', () => {
      manager.setPort(port);
      const batchCb = vi.fn();
      manager.onData('q1', batchCb);
      manager.onError('q1', vi.fn());

      simulateMessage(port, {
        type: 'arrow-error',
        queryId: 'q1',
        code: 'E1001',
        message: 'err',
        batchesSent: 0,
      });

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 10,
        byteSize: 100,
        buffer: new ArrayBuffer(100),
      });

      expect(batchCb).not.toHaveBeenCalled();
    });
  });

  describe('cancelQuery', () => {
    it('sends cancel message on port', () => {
      manager.setPort(port);
      manager.cancelQuery('q1');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'cancel',
        queryId: 'q1',
        reason: 'user_cancelled',
      });
    });

    it('sends custom reason', () => {
      manager.setPort(port);
      manager.cancelQuery('q1', 'timeout');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'cancel',
        queryId: 'q1',
        reason: 'timeout',
      });
    });

    it('cleans up callbacks for the query', () => {
      manager.setPort(port);
      const batchCb = vi.fn();
      manager.onData('q1', batchCb);

      manager.cancelQuery('q1');

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 10,
        byteSize: 100,
        buffer: new ArrayBuffer(100),
      });

      expect(batchCb).not.toHaveBeenCalled();
    });

    it('does nothing when no port is set', () => {
      // No port set — should not throw
      manager.cancelQuery('q1');
    });
  });

  describe('multiple queries', () => {
    it('handles interleaved batches for different queries', () => {
      manager.setPort(port);
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      manager.onData('q1', cb1);
      manager.onData('q2', cb2);

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 10,
        byteSize: 100,
        buffer: new ArrayBuffer(100),
      });

      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q2',
        index: 0,
        rowCount: 20,
        byteSize: 200,
        buffer: new ArrayBuffer(200),
      });

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('end of one query does not affect another', () => {
      manager.setPort(port);
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      manager.onData('q1', cb1);
      manager.onData('q2', cb2);
      manager.onEnd('q1', vi.fn());

      // End query 1
      simulateMessage(port, {
        type: 'arrow-end',
        queryId: 'q1',
        totalBatches: 1,
        totalRows: 10,
        totalBytes: 100,
        durationMs: 5,
      });

      // Query 2 should still work
      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q2',
        index: 0,
        rowCount: 20,
        byteSize: 200,
        buffer: new ArrayBuffer(200),
      });

      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe('onEnd unsubscribe', () => {
    it('prevents end callback from firing after unsubscribe', () => {
      // Kills: return () => this.endCallbacks.delete(queryId) → return () => undefined
      manager.setPort(port);
      const callback = vi.fn();
      const unsub = manager.onEnd('q1', callback);

      unsub();

      simulateMessage(port, {
        type: 'arrow-end',
        queryId: 'q1',
        totalBatches: 1,
        totalRows: 10,
        totalBytes: 100,
        durationMs: 5,
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('onError unsubscribe', () => {
    it('prevents error callback from firing after unsubscribe', () => {
      // Kills: return () => this.errorCallbacks.delete(queryId) → return () => undefined
      manager.setPort(port);
      const callback = vi.fn();
      const unsub = manager.onError('q1', callback);

      unsub();

      simulateMessage(port, {
        type: 'arrow-error',
        queryId: 'q1',
        code: 'E1001',
        message: 'syntax error',
        batchesSent: 0,
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('unhandled messages', () => {
    it('ignores unknown message types', () => {
      manager.setPort(port);

      // Should not throw
      simulateMessage(port, { type: 'unknown', queryId: 'q1' });
    });

    it('ignores batches for unregistered queries', () => {
      manager.setPort(port);

      // Should not throw — no callback registered for 'q99'
      simulateMessage(port, {
        type: 'arrow-batch',
        queryId: 'q99',
        index: 0,
        rowCount: 10,
        byteSize: 100,
        buffer: new ArrayBuffer(100),
      });

      // ACK should still be sent
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'ack',
        queryId: 'q99',
        index: 0,
      });
    });
  });
});
