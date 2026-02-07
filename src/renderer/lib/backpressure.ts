import type {
  ArrowBatch,
  ArrowBatchMessage,
  StreamEndMessage,
  DataPlaneError,
} from '@shared/types';

type BatchCallback = (batch: ArrowBatch) => void;
type EndCallback = (info: {
  queryId: string;
  totalRows: number;
  totalBatches: number;
  totalBytes: number;
  durationMs: number;
}) => void;
type ErrorCallback = (error: {
  queryId: string;
  code: string;
  message: string;
}) => void;

export class BackpressureManager {
  private port: MessagePort | null = null;
  private batchCallbacks = new Map<string, BatchCallback>();
  private endCallbacks = new Map<string, EndCallback>();
  private errorCallbacks = new Map<string, ErrorCallback>();

  setPort(port: MessagePort): void {
    this.port = port;
    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.port.start();
  }

  /** Register callbacks for a query's data stream */
  onData(queryId: string, callback: BatchCallback): () => void {
    this.batchCallbacks.set(queryId, callback);
    return () => this.batchCallbacks.delete(queryId);
  }

  onEnd(queryId: string, callback: EndCallback): () => void {
    this.endCallbacks.set(queryId, callback);
    return () => this.endCallbacks.delete(queryId);
  }

  onError(queryId: string, callback: ErrorCallback): () => void {
    this.errorCallbacks.set(queryId, callback);
    return () => this.errorCallbacks.delete(queryId);
  }

  /** Send a cancel message on the data plane */
  cancelQuery(queryId: string, reason: string = 'user_cancelled'): void {
    if (!this.port) return;
    this.port.postMessage({ type: 'cancel', queryId, reason });
    this.cleanup(queryId);
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'arrow-batch':
        this.handleBatch(msg);
        break;
      case 'arrow-end':
        this.handleEnd(msg);
        break;
      case 'arrow-error':
        this.handleError(msg);
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

// Singleton instance
export const backpressureManager = new BackpressureManager();
