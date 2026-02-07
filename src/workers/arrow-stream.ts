/**
 * Arrow IPC batch production with backpressure for the DuckDB Worker Thread.
 *
 * Executes queries via DuckDB's `to_arrow_ipc()`, produces Arrow IPC buffers,
 * and streams them to the Renderer via a MessagePort data channel. Implements
 * a sliding-window ACK protocol for backpressure control.
 */

import type { MessagePort } from 'node:worker_threads';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { BACKPRESSURE } from '@shared/constants';
import type {
  ArrowBatchMessage,
  BatchAckMessage,
  DataPlaneError,
  StreamEndMessage,
} from '@shared/types';

/** Polling interval (ms) when waiting for the ACK window to drain. */
const ACK_POLL_INTERVAL_MS = 10;

/**
 * Streams Arrow IPC batches from DuckDB query results to the renderer via a MessagePort.
 *
 * Implements a sliding-window ACK protocol for backpressure control,
 * ensuring the renderer is not overwhelmed by large result sets.
 */
export class ArrowStream {
  private dataPort: MessagePort | null = null;
  private pendingAcks = new Map<string, Set<number>>(); // queryId -> set of unacked batch indices
  private cancelled = new Set<string>();

  /**
   * Attach the MessagePort used as the data-plane channel.
   * Incoming messages are ACKs or cancel requests from the Renderer.
   */
  setDataPort(port: MessagePort): void {
    this.dataPort = port;
    this.dataPort.on('message', (data: unknown) => {
      this.handleAck(data);
    });
  }

  /**
   * Handle incoming data-plane messages from the Renderer.
   *  - 'ack': remove the acknowledged batch index from pendingAcks
   *  - 'cancel': mark the query as cancelled
   */
  private handleAck(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;

    const message = msg as Record<string, unknown>;

    if (message['type'] === 'ack') {
      const ack = message as unknown as BatchAckMessage;
      const pending = this.pendingAcks.get(ack.queryId);
      if (pending) {
        pending.delete(ack.index);
        if (pending.size === 0) {
          this.pendingAcks.delete(ack.queryId);
        }
      }
    } else if (message['type'] === 'cancel') {
      const queryId = message['queryId'] as string;
      if (queryId) {
        this.cancelled.add(queryId);
      }
    }
  }

  /**
   * Execute a SQL query, produce Arrow IPC batch(es), and stream them
   * over the data-plane MessagePort.
   *
   * Returns summary statistics on completion.
   */
  async streamQuery(
    connection: DuckDBConnection,
    queryId: string,
    sql: string,
    params?: unknown[],
  ): Promise<{ totalRows: number; totalBatches: number; totalBytes: number; durationMs: number }> {
    const startMs = Date.now();
    let batchesSent = 0;
    let totalBytes = 0;
    const totalRows = 0;

    // Check for pre-cancellation
    if (this.cancelled.has(queryId)) {
      this.sendEnd(queryId, 0, 0, 0, Date.now() - startMs);
      this.cancelled.delete(queryId);
      return { totalRows: 0, totalBatches: 0, totalBytes: 0, durationMs: Date.now() - startMs };
    }

    try {
      // Wrap user SQL with DuckDB's to_arrow_ipc() to produce an Arrow IPC buffer
      const wrappedSql = `SELECT * FROM to_arrow_ipc((${sql}))`;
      const result =
        params && params.length > 0
          ? await connection.run(wrappedSql, params as DuckDBValue[])
          : await connection.run(wrappedSql);
      const rows = await result.getRows();

      // Check for cancellation after query execution
      if (this.cancelled.has(queryId)) {
        this.sendEnd(queryId, 0, 0, 0, Date.now() - startMs);
        this.cancelled.delete(queryId);
        return { totalRows: 0, totalBatches: 0, totalBytes: 0, durationMs: Date.now() - startMs };
      }

      const firstRow = rows[0];
      if (firstRow?.[0]) {
        // The IPC buffer from DuckDB may be backed by a SharedArrayBuffer.
        // We MUST create an owned copy before transferring ownership.
        const ipcBuffer = firstRow[0] as unknown as Uint8Array;
        const buffer = new ArrayBuffer(ipcBuffer.byteLength);
        new Uint8Array(buffer).set(ipcBuffer);

        const byteSize = buffer.byteLength;

        // Backpressure: wait until the ACK window has room
        const windowOpen = await this.waitForWindow(queryId);
        if (!windowOpen) {
          // Cancelled while waiting
          this.sendEnd(queryId, batchesSent, totalRows, totalBytes, Date.now() - startMs);
          return {
            totalRows,
            totalBatches: batchesSent,
            totalBytes,
            durationMs: Date.now() - startMs,
          };
        }

        // Send the Arrow IPC batch
        this.sendBatch(queryId, buffer, 0, 0 /* row count not available from to_arrow_ipc */);
        batchesSent = 1;
        totalBytes = byteSize;

        // Send stream-end signal
        const durationMs = Date.now() - startMs;
        this.sendEnd(queryId, batchesSent, totalRows, totalBytes, durationMs);

        return { totalRows, totalBatches: batchesSent, totalBytes, durationMs };
      }

      // No result rows: send an empty end message
      const durationMs = Date.now() - startMs;
      this.sendEnd(queryId, 0, 0, 0, durationMs);
      return { totalRows: 0, totalBatches: 0, totalBytes: 0, durationMs };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const code = this.classifyErrorCode(errMsg);
      this.sendError(queryId, code, errMsg, batchesSent);
      throw error;
    }
  }

  /**
   * Mark a query as cancelled. Outstanding ACKs are discarded.
   */
  cancelQuery(queryId: string): void {
    this.cancelled.add(queryId);
    this.pendingAcks.delete(queryId);
  }

  /**
   * Wait until the sliding ACK window has room for another batch.
   * Returns false if the query is cancelled while waiting.
   */
  private async waitForWindow(queryId: string): Promise<boolean> {
    for (;;) {
      if (this.cancelled.has(queryId)) {
        return false;
      }

      const pending = this.pendingAcks.get(queryId);
      const inflightCount = pending ? pending.size : 0;

      if (inflightCount < BACKPRESSURE.WINDOW_SIZE) {
        return true;
      }

      // Yield and poll again after a short delay
      await new Promise<void>((resolve) => setTimeout(resolve, ACK_POLL_INTERVAL_MS));
    }
  }

  /**
   * Send a single Arrow IPC batch over the data-plane MessagePort.
   * The ArrayBuffer is transferred (zero-copy) to the Renderer.
   */
  private sendBatch(queryId: string, buffer: ArrayBuffer, index: number, rowCount: number): void {
    if (!this.dataPort) return;

    const msg: ArrowBatchMessage = {
      type: 'arrow-batch',
      queryId,
      index,
      rowCount,
      byteSize: buffer.byteLength,
    };

    // Track pending ACK
    if (!this.pendingAcks.has(queryId)) {
      this.pendingAcks.set(queryId, new Set());
    }
    this.pendingAcks.get(queryId)?.add(index);

    // Transfer the ArrayBuffer (zero-copy handoff)
    this.dataPort.postMessage({ ...msg, buffer }, [buffer]);
  }

  /**
   * Signal that all batches for a query have been sent.
   */
  private sendEnd(
    queryId: string,
    totalBatches: number,
    totalRows: number,
    totalBytes: number,
    durationMs: number,
  ): void {
    if (!this.dataPort) return;

    const msg: StreamEndMessage = {
      type: 'arrow-end',
      queryId,
      totalBatches,
      totalRows,
      totalBytes,
      durationMs,
    };
    this.dataPort.postMessage(msg);

    // Clean up tracking state
    this.pendingAcks.delete(queryId);
    this.cancelled.delete(queryId);
  }

  /**
   * Send an error over the data-plane for a failed query.
   */
  private sendError(queryId: string, code: string, message: string, batchesSent: number): void {
    if (!this.dataPort) return;

    const msg: DataPlaneError = {
      type: 'arrow-error',
      queryId,
      code,
      message,
      batchesSent,
    };
    this.dataPort.postMessage(msg);

    // Clean up tracking state
    this.pendingAcks.delete(queryId);
    this.cancelled.delete(queryId);
  }

  /**
   * Map DuckDB error messages to taxonomy error codes.
   */
  private classifyErrorCode(message: string): string {
    const msg = message.toLowerCase();
    if (msg.includes('syntax error') || msg.includes('parser error')) return 'E1001';
    if (msg.includes('does not exist') && msg.includes('table')) return 'E1004';
    if (msg.includes('does not exist') && msg.includes('column')) return 'E1005';
    if (msg.includes('type mismatch')) return 'E1006';
    if (msg.includes('out of memory') || msg.includes('memory limit')) return 'E1007';
    return 'E1001';
  }
}
