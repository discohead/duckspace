import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HEALTH_CHECK, PUSH_EVENTS } from '@shared/constants';
import {
  HeartbeatAckSchema,
  QueryHistoryRecordMessageSchema,
  WorkerErrorMessageSchema,
  WorkerHealthResponseSchema,
  WorkerReadyMessageSchema,
} from '@shared/schemas/worker-schemas';
import type {
  HeartbeatAck,
  QueryHistoryPushRecord,
  WorkerHealthRecord,
  WorkerHealthResponse,
  WorkerReadyMessage,
} from '@shared/types';
import type { BrowserWindow } from 'electron';

/** Lifecycle status of the DuckDB worker thread. */
export type WorkerStatus = 'starting' | 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';

interface WorkerManagerConfig {
  dbPath: string;
  memoryLimit: string;
  threads: number;
  tempDirectory: string;
  extensions: string[];
  /** Optional path to bundled extensions directory (production only) */
  extensionDirectory?: string;
  v8HeapLimitMB: number;
  healthCheckIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxRestartAttempts: number;
}

/**
 * Manages the lifecycle of the DuckDB worker thread.
 *
 * Handles spawning, health monitoring, automatic restarts, and graceful shutdown
 * of the worker. Pushes health status updates to the renderer.
 */
export class WorkerManager {
  private worker: Worker | null = null;
  private status: WorkerStatus = 'starting';
  private restartCount = 0;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private config: WorkerManagerConfig;
  private mainWindow: BrowserWindow | null = null;
  private readyPromise: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private upSince: string = new Date().toISOString();
  private consecutiveMisses = 0;

  /**
   * Creates a new WorkerManager with the given configuration.
   *
   * @param config - Worker configuration including database path, memory limits, and health check settings.
   */
  constructor(config: WorkerManagerConfig) {
    this.config = config;
  }

  /**
   * Spawns the DuckDB worker thread and waits for it to signal ready.
   *
   * @throws {@link Error} If the worker fails to start within the 30-second timeout.
   */
  async spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyPromise = { resolve, reject };

      // Worker is built by Vite as a separate target into the same build directory
      const workerPath = path.join(__dirname, 'duckdb-worker.js');
      this.worker = new Worker(workerPath, {
        workerData: {
          dbPath: this.config.dbPath,
          memoryLimit: this.config.memoryLimit,
          threads: this.config.threads,
          tempDirectory: this.config.tempDirectory,
          extensions: this.config.extensions,
          extensionDirectory: this.config.extensionDirectory,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: this.config.v8HeapLimitMB,
        },
      });

      this.upSince = new Date().toISOString();

      this.worker.on('message', (msg: Record<string, unknown>) => {
        this.handleWorkerMessage(msg);
      });

      this.worker.on('error', (err: Error) => {
        this.handleWorkerError(err);
      });

      this.worker.on('exit', (code: number) => {
        this.handleWorkerExit(code);
      });

      // Timeout for initial startup
      setTimeout(() => {
        if (this.readyPromise) {
          this.readyPromise.reject(new Error('Worker startup timed out'));
          this.readyPromise = null;
        }
      }, 30000);
    });
  }

  /**
   * Sets the main window reference for pushing health status updates.
   *
   * @param win - The main BrowserWindow instance.
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * Returns the underlying worker thread instance.
   *
   * @returns The worker thread, or null if not yet spawned or terminated.
   */
  getWorker(): Worker | null {
    return this.worker;
  }

  /**
   * Returns the current lifecycle status of the worker.
   *
   * @returns The worker's current status.
   */
  getStatus(): WorkerStatus {
    return this.status;
  }

  /**
   * Returns the number of times the worker has been restarted.
   *
   * @returns The cumulative restart count.
   */
  getRestartCount(): number {
    return this.restartCount;
  }

  /**
   * Starts periodic heartbeat health checks to the worker.
   *
   * No-op if health monitoring is already active.
   */
  startHealthMonitoring(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Stops the periodic heartbeat health checks.
   */
  stopHealthMonitoring(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private sendHeartbeat(): void {
    if (!this.worker || this.status === 'failed') return;

    const sentAt = Date.now();
    this.worker.postMessage({ type: 'heartbeat', sentAt });

    setTimeout(() => {
      this.consecutiveMisses++;
      if (this.consecutiveMisses >= HEALTH_CHECK.MAX_CONSECUTIVE_MISSES) {
        this.setStatus('degraded');
      }
    }, this.config.heartbeatTimeoutMs);
  }

  private handleWorkerMessage(msg: Record<string, unknown>): void {
    switch (msg['type']) {
      case 'ready': {
        const parsed = WorkerReadyMessageSchema.safeParse(msg);
        if (parsed.success) {
          this.handleReady(parsed.data);
        } else {
          console.error('Invalid ready message:', parsed.error.issues);
        }
        break;
      }
      case 'heartbeat_ack': {
        const parsed = HeartbeatAckSchema.safeParse(msg);
        if (parsed.success) {
          this.handleHeartbeatAck(parsed.data);
        } else {
          console.error('Invalid heartbeat_ack message:', parsed.error.issues);
        }
        break;
      }
      case 'health_check_result': {
        const parsed = WorkerHealthResponseSchema.safeParse(msg);
        if (parsed.success) {
          this.handleHealthCheckResult(parsed.data);
        } else {
          console.error('Invalid health_check_result message:', parsed.error.issues);
        }
        break;
      }
      case 'port-ready':
        // Data port established
        break;
      case 'query_history_record': {
        const parsed = QueryHistoryRecordMessageSchema.safeParse(msg);
        if (parsed.success) {
          this.forwardQueryHistoryToRenderer(parsed.data);
        } else {
          console.error('Invalid query_history_record message:', parsed.error.issues);
        }
        break;
      }
      case 'table_info':
      case 'catalog_update':
        // Forward to IPC handlers
        break;
      case 'shutdown-complete':
        this.status = 'failed'; // Worker is done
        break;
      case 'error': {
        const parsed = WorkerErrorMessageSchema.safeParse(msg);
        if (parsed.success) {
          console.error('Worker error:', parsed.data.message);
        } else {
          console.error('Worker error (unparsed):', msg['message']);
        }
        break;
      }
    }
  }

  private handleReady(msg: WorkerReadyMessage): void {
    if (msg.metadata?.integrityOk === false) {
      console.warn('DuckDB integrity check failed — starting in degraded mode');
      this.status = 'degraded';
    } else {
      this.status = 'ready';
    }

    if (this.readyPromise) {
      this.readyPromise.resolve();
      this.readyPromise = null;
    }

    this.pushHealthToRenderer();
  }

  private handleHeartbeatAck(ack: HeartbeatAck): void {
    this.consecutiveMisses = 0;
    if (ack.status === 'busy') {
      this.setStatus('busy');
    } else if (ack.status === 'healthy') {
      this.setStatus('ready');
    } else {
      this.setStatus('degraded');
    }
  }

  private handleHealthCheckResult(_result: WorkerHealthResponse): void {
    // No-op: health checks are superseded by heartbeat monitoring.
    // Messages intentionally discarded — status is derived from heartbeat ACKs.
  }

  private handleWorkerError(err: Error): void {
    console.error('DuckDB Worker error:', err);
    this.setStatus('degraded');
  }

  private handleWorkerExit(code: number): void {
    if (code !== 0 && this.status !== 'failed') {
      void this.attemptRestart();
    }
  }

  private async attemptRestart(): Promise<void> {
    if (this.restartCount >= this.config.maxRestartAttempts) {
      this.setStatus('failed');
      return;
    }

    this.setStatus('restarting');
    this.restartCount++;
    this.worker = null;

    try {
      await this.spawn();
      this.startHealthMonitoring();
    } catch (err) {
      console.error('DuckDB Worker restart failed:', err);
      this.setStatus('failed');
    }
  }

  private setStatus(newStatus: WorkerStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    this.pushHealthToRenderer();
  }

  private forwardQueryHistoryToRenderer(msg: {
    queryId: string;
    sql: string;
    executionTimeMs: number;
    rowCount: number;
    status: 'success' | 'error';
    errorMessage?: string | undefined;
  }): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const record: QueryHistoryPushRecord = {
      queryId: msg.queryId,
      sql: msg.sql,
      executionTimeMs: msg.executionTimeMs,
      rowCount: msg.rowCount,
      status: msg.status,
      ...(msg.errorMessage !== undefined ? { errorMessage: msg.errorMessage } : {}),
    };
    this.mainWindow.webContents.send(PUSH_EVENTS.QUERY_HISTORY, record);
  }

  /**
   * Pushes the current health status to the renderer.
   *
   * Call after the renderer is ready to ensure it receives the initial state.
   */
  pushCurrentHealth(): void {
    this.pushHealthToRenderer();
  }

  private pushHealthToRenderer(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    this.mainWindow.webContents.send(PUSH_EVENTS.WORKER_STATUS, {
      worker: 'duckdb',
      status: this.status,
      restartCount: this.restartCount,
      message: this.getStatusMessage(),
    });
  }

  /**
   * Returns a snapshot of the worker's health state for persistence.
   *
   * @returns A health record with status, restart count, and uptime info.
   */
  getHealthRecord(): WorkerHealthRecord {
    return {
      id: 'duckdb',
      // Map 'starting' → 'ready' because the WorkerHealthRecord schema only
      // allows terminal statuses. During startup the worker is not yet failed/degraded,
      // so 'ready' is the closest valid representation for external consumers.
      status: this.status === 'starting' ? 'ready' : this.status,
      restartCount: this.restartCount,
      lastHeartbeatAt: new Date().toISOString(),
      upSince: this.upSince,
      activeQueryCount: 0,
    };
  }

  private getStatusMessage(): string {
    switch (this.status) {
      case 'ready':
        return 'DuckDB engine is ready';
      case 'busy':
        return 'DuckDB engine is processing queries';
      case 'degraded':
        return 'DuckDB engine is experiencing issues';
      case 'restarting':
        return `DuckDB engine is restarting (attempt ${this.restartCount})`;
      case 'failed':
        return 'DuckDB engine has failed and cannot restart';
      case 'starting':
        return 'DuckDB engine is starting';
    }
  }

  /**
   * Gracefully shuts down the worker by sending a shutdown message.
   *
   * Waits up to 5 seconds for a shutdown-complete response before
   * forcefully terminating the worker thread.
   */
  async shutdown(): Promise<void> {
    this.stopHealthMonitoring();

    if (!this.worker) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.worker?.removeListener('message', onMessage);
        void this.worker?.terminate();
        resolve();
      }, 5000);

      const onMessage = (msg: Record<string, unknown>): void => {
        if (msg['type'] === 'shutdown-complete') {
          this.worker?.removeListener('message', onMessage);
          clearTimeout(timeout);
          resolve();
        }
      };
      this.worker?.on('message', onMessage);

      this.worker?.postMessage({ type: 'shutdown' });
    });
  }
}
