import { Worker } from 'worker_threads';
import path from 'path';
import type { BrowserWindow } from 'electron';
import type {
  WorkerHealthResponse,
  HeartbeatAck,
  WorkerReadyMessage,
  WorkerHealthRecord,
  QueryHistoryPushRecord,
} from '@shared/types';
import { HEALTH_CHECK, PUSH_EVENTS } from '@shared/constants';

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

export class WorkerManager {
  private worker: Worker | null = null;
  private status: WorkerStatus = 'starting';
  private restartCount = 0;
  private consecutiveMisses = 0;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private config: WorkerManagerConfig;
  private mainWindow: BrowserWindow | null = null;
  private readyPromise: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private upSince: string = new Date().toISOString();

  constructor(config: WorkerManagerConfig) {
    this.config = config;
  }

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

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  getWorker(): Worker | null {
    return this.worker;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getRestartCount(): number {
    return this.restartCount;
  }

  startHealthMonitoring(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.healthCheckIntervalMs);
  }

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

    // Set timeout for heartbeat response
    setTimeout(() => {
      // If we haven't received an ack, count as a miss
      // The ack handler resets consecutiveMisses
    }, this.config.heartbeatTimeoutMs);
  }

  private handleWorkerMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ready':
        this.handleReady(msg as unknown as WorkerReadyMessage);
        break;
      case 'heartbeat_ack':
        this.handleHeartbeatAck(msg as unknown as HeartbeatAck);
        break;
      case 'health_check_result':
        this.handleHealthCheckResult(msg as unknown as WorkerHealthResponse);
        break;
      case 'port-ready':
        // Data port established
        break;
      case 'query_history_record':
        this.forwardQueryHistoryToRenderer(msg as unknown as QueryHistoryPushRecord & { type: string });
        break;
      case 'table_info':
      case 'catalog_update':
        // Forward to IPC handlers
        break;
      case 'shutdown-complete':
        this.status = 'failed'; // Worker is done
        break;
      case 'error':
        console.error('Worker error:', msg.message);
        break;
    }
  }

  private handleReady(_msg: WorkerReadyMessage): void {
    this.status = 'ready';
    this.consecutiveMisses = 0;

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
    } else if (ack.status === 'degraded') {
      this.setStatus('degraded');
    }
  }

  private handleHealthCheckResult(result: WorkerHealthResponse): void {
    if (result.status === 'healthy') {
      this.consecutiveMisses = 0;
    }
  }

  private handleWorkerError(err: Error): void {
    console.error('DuckDB Worker error:', err);
    this.setStatus('degraded');
  }

  private handleWorkerExit(code: number): void {
    if (code !== 0 && this.status !== 'failed') {
      this.attemptRestart();
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
    } catch {
      this.setStatus('failed');
    }
  }

  private setStatus(newStatus: WorkerStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    this.pushHealthToRenderer();
  }

  private forwardQueryHistoryToRenderer(msg: QueryHistoryPushRecord & { type: string }): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const record: QueryHistoryPushRecord = {
      queryId: msg.queryId,
      sql: msg.sql,
      executionTimeMs: msg.executionTimeMs,
      rowCount: msg.rowCount,
      status: msg.status,
      errorMessage: msg.errorMessage,
    };
    this.mainWindow.webContents.send(PUSH_EVENTS.QUERY_HISTORY, record);
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

  getHealthRecord(): WorkerHealthRecord {
    return {
      id: 'duckdb',
      status: this.status === 'starting' ? 'ready' : this.status,
      restartCount: this.restartCount,
      lastHeartbeatAt: new Date().toISOString(),
      upSince: this.upSince,
      activeQueryCount: 0,
    };
  }

  private getStatusMessage(): string {
    switch (this.status) {
      case 'ready': return 'DuckDB engine is ready';
      case 'busy': return 'DuckDB engine is processing queries';
      case 'degraded': return 'DuckDB engine is experiencing issues';
      case 'restarting': return `DuckDB engine is restarting (attempt ${this.restartCount})`;
      case 'failed': return 'DuckDB engine has failed and cannot restart';
      default: return 'DuckDB engine is starting';
    }
  }

  async shutdown(): Promise<void> {
    this.stopHealthMonitoring();

    if (!this.worker) return;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.worker?.terminate();
        resolve();
      }, 5000);

      this.worker!.once('message', (msg: Record<string, unknown>) => {
        if (msg.type === 'shutdown-complete') {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.worker!.postMessage({ type: 'shutdown' });
    });
  }
}
