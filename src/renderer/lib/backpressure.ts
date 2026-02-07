import type {
  ArrowBatch,
  ArrowBatchMessage,
  DataPlaneError,
  StreamEndMessage,
} from '@shared/types';

type BatchCallback = (batch: ArrowBatch) => void;
type EndCallback = (info: {
  queryId: string;
  totalRows: number;
  totalBatches: number;
  totalBytes: number;
  durationMs: number;
}) => void;
type ErrorCallback = (error: { queryId: string; code: string; message: string }) => void;

interface DataPlaneMessage {
  type: string;
  queryId: string;
  index?: number;
  rowCount?: number;
  byteSize?: number;
  buffer?: ArrayBuffer;
  totalRows?: number;
  totalBatches?: number;
  totalBytes?: number;
  durationMs?: number;
  code?: string;
  message?: string;
  batchesSent?: number;
}

/**
 * Manages the data-plane MessagePort connection between the renderer and the main process bridge.
 * Handles Arrow IPC batch delivery with ACK-based backpressure, stream-end signals,
 * and error propagation. Provides per-query callback registration for batch, end, and error events.
 */
export class BackpressureManager {
  private port: MessagePort | null = null;
  private batchCallbacks = new Map<string, BatchCallback>();
  private endCallbacks = new Map<string, EndCallback>();
  private errorCallbacks = new Map<string, ErrorCallback>();

  /**
   * Assigns the MessagePort for data-plane communication and starts listening for messages.
   *
   * @param port - The MessagePort connected to the main process bridge.
   */
  setPort(port: MessagePort): void {
    this.port = port;
    this.port.onmessage = (event: MessageEvent<DataPlaneMessage>) => {
      this.handleMessage(event.data);
    };
    this.port.start();
  }

  /**
   * Registers a callback for Arrow IPC batch events on a specific query.
   *
   * @param queryId - The query to listen for.
   * @param callback - Invoked for each received batch.
   * @returns An unsubscribe function.
   */
  onData(queryId: string, callback: BatchCallback): () => void {
    this.batchCallbacks.set(queryId, callback);
    return () => this.batchCallbacks.delete(queryId);
  }

  /**
   * Registers a callback for the stream-end signal on a specific query.
   *
   * @param queryId - The query to listen for.
   * @param callback - Invoked when the stream ends with summary statistics.
   * @returns An unsubscribe function.
   */
  onEnd(queryId: string, callback: EndCallback): () => void {
    this.endCallbacks.set(queryId, callback);
    return () => this.endCallbacks.delete(queryId);
  }

  /**
   * Registers a callback for data-plane errors on a specific query.
   *
   * @param queryId - The query to listen for.
   * @param callback - Invoked when an error occurs during streaming.
   * @returns An unsubscribe function.
   */
  onError(queryId: string, callback: ErrorCallback): () => void {
    this.errorCallbacks.set(queryId, callback);
    return () => this.errorCallbacks.delete(queryId);
  }

  /**
   * Sends a cancel message on the data plane and cleans up query callbacks.
   *
   * @param queryId - The query to cancel.
   * @param reason - The cancellation reason sent to the worker.
   */
  cancelQuery(queryId: string, reason = 'user_cancelled'): void {
    if (!this.port) return;
    this.port.postMessage({ type: 'cancel', queryId, reason });
    this.cleanup(queryId);
  }

  private handleMessage(msg: DataPlaneMessage): void {
    switch (msg.type) {
      case 'arrow-batch':
        this.handleBatch(msg as unknown as ArrowBatchMessage & { buffer: ArrayBuffer });
        break;
      case 'arrow-end':
        this.handleEnd(msg as unknown as StreamEndMessage);
        break;
      case 'arrow-error':
        this.handleError(msg as unknown as DataPlaneError);
        break;
    }
  }

  private handleBatch(msg: ArrowBatchMessage & { buffer: ArrayBuffer }): void {
    // Send ACK back to Worker
    this.sendAck(msg.queryId, msg.index);

    // Create ArrowBatch and call callback
    const batch: ArrowBatch = {
      buffer: msg.buffer,
      index: msg.index,
      rowCount: msg.rowCount,
      byteSize: msg.byteSize,
      isLast: false,
    };

    const callback = this.batchCallbacks.get(msg.queryId);
    if (callback) {
      callback(batch);
    }
  }

  private handleEnd(msg: StreamEndMessage): void {
    const callback = this.endCallbacks.get(msg.queryId);
    if (callback) {
      callback({
        queryId: msg.queryId,
        totalRows: msg.totalRows,
        totalBatches: msg.totalBatches,
        totalBytes: msg.totalBytes,
        durationMs: msg.durationMs,
      });
    }
    this.cleanup(msg.queryId);
  }

  private handleError(msg: DataPlaneError): void {
    const callback = this.errorCallbacks.get(msg.queryId);
    if (callback) {
      callback({
        queryId: msg.queryId,
        code: msg.code,
        message: msg.message,
      });
    }
    this.cleanup(msg.queryId);
  }

  private sendAck(queryId: string, index: number): void {
    if (!this.port) return;
    this.port.postMessage({ type: 'ack', queryId, index });
  }

  private cleanup(queryId: string): void {
    this.batchCallbacks.delete(queryId);
    this.endCallbacks.delete(queryId);
    this.errorCallbacks.delete(queryId);
  }
}
