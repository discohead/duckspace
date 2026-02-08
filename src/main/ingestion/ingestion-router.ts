/**
 * Central orchestrator for file ingestion in the Main process.
 *
 * Coordinates the import flow: validate file paths, detect formats, create
 * DataSource entries, send Worker messages, track progress, update DataSource
 * status on completion/failure, and relay progress events to the Renderer.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { Worker } from 'node:worker_threads';
import { PUSH_EVENTS } from '@shared/constants';
import { fileNotFoundError, filePermissionDeniedError } from '@shared/errors';
import type {
  DataSource,
  DataSourceFormat,
  ImportFilesResponse,
  ImportFilesResponseJob,
  IngestionJob,
  IngestionTrigger,
} from '@shared/types';
import type { BrowserWindow } from 'electron';
import { detectFormat, generateTableName } from './format-detector';
import { ProgressTracker } from './progress-tracker';

/** Active table names in DuckDB, used for collision avoidance. */
const registeredTableNames = new Set<string>();

/** Progress tracker singleton. */
const progressTracker = new ProgressTracker();

/** Reference to the DuckDB worker thread, set by {@link setWorker}. */
let worker: Worker | null = null;

/** Reference to the main BrowserWindow, set by {@link setMainWindow}. */
let mainWindow: BrowserWindow | null = null;

/**
 * Sets the DuckDB worker reference for sending ingestion messages.
 *
 * @param w - The DuckDB worker thread.
 */
export function setWorker(w: Worker): void {
  worker = w;
}

/**
 * Sets the main window reference for relaying progress events to the renderer.
 *
 * @param win - The main BrowserWindow.
 */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

/**
 * Returns the progress tracker singleton (for IPC handler use).
 *
 * @returns The shared {@link ProgressTracker} instance.
 */
export function getProgressTracker(): ProgressTracker {
  return progressTracker;
}

/**
 * Import one or more files into DuckDB.
 *
 * Validates paths, detects formats, creates DataSource entries,
 * sends Worker messages, and returns job metadata for each file.
 *
 * @param filePaths - Absolute paths to import.
 * @param trigger - How the import was initiated.
 * @returns One job entry per file path.
 * @throws DatspaceError E2001 if a file does not exist.
 * @throws DatspaceError E2003 if a file is not readable.
 */
export async function importFiles(
  filePaths: readonly string[],
  trigger: IngestionTrigger,
): Promise<ImportFilesResponse> {
  if (worker === null) {
    throw new Error('Worker not initialized');
  }

  const jobs: ImportFilesResponseJob[] = [];

  for (const filePath of filePaths) {
    // Validate file exists and is readable
    let fileSizeBytes: number;
    try {
      const stats = await stat(filePath);
      fileSizeBytes = stats.size;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw fileNotFoundError(filePath);
      }
      if (code === 'EACCES') {
        throw filePermissionDeniedError(filePath);
      }
      throw err;
    }

    // Detect format
    const format: DataSourceFormat = await detectFormat(filePath);

    // Generate unique table name
    const tableName = generateTableName(filePath, registeredTableNames);
    registeredTableNames.add(tableName);

    // Create job ID and data source ID
    const jobId = crypto.randomUUID();
    const dataSourceId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Start progress tracking
    progressTracker.startJob(jobId, fileSizeBytes);

    // Send ingestion message to worker
    worker.postMessage({
      type: 'ingest_file',
      jobId,
      filePath,
      format,
      tableName,
      options: {},
    });

    jobs.push({
      jobId,
      dataSourceId,
      filePath,
      format,
    });

    // Relay to renderer: notify about new data source and job
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      const dataSource: DataSource = {
        id: dataSourceId,
        name: path.basename(filePath, path.extname(filePath)),
        filePath,
        format,
        status: 'importing',
        duckdbTableName: tableName,
        fileSizeBytes,
        tags: [],
        createdAt: now,
        updatedAt: now,
      };

      const ingestionJob: IngestionJob = {
        id: jobId,
        dataSourceId,
        status: 'running',
        filePath,
        format,
        fileSizeBytes,
        rowsProcessed: 0,
        batchesReceived: 0,
        bytesProcessed: 0,
        startedAt: now,
        triggeredBy: trigger,
      };

      mainWindow.webContents.send(PUSH_EVENTS.CATALOG_SOURCE_UPDATED, {
        type: 'source_created',
        dataSource,
      });

      mainWindow.webContents.send(PUSH_EVENTS.INGESTION_PROGRESS, {
        jobId,
        dataSourceId,
        ingestionJob,
        status: 'running',
        rowsProcessed: 0,
        bytesProcessed: 0,
        percentage: 0,
        elapsedMs: 0,
      });
    }
  }

  return { type: 'ingestion:importFiles:response', jobs };
}

/**
 * Handle a progress update message from the DuckDB worker.
 * Updates the progress tracker and relays to the renderer.
 *
 * @param msg - The progress message from the worker.
 */
export function handleWorkerProgress(msg: {
  readonly jobId: string;
  readonly rowsProcessed: number;
  readonly bytesProcessed: number;
  readonly batchIndex: number;
  readonly durationMs: number;
}): void {
  progressTracker.updateProgress(msg.jobId, msg.rowsProcessed, msg.bytesProcessed, msg.batchIndex);

  const estimate = progressTracker.estimateCompletion(msg.jobId);

  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH_EVENTS.INGESTION_PROGRESS, {
      jobId: msg.jobId,
      status: 'running',
      rowsProcessed: msg.rowsProcessed,
      bytesProcessed: msg.bytesProcessed,
      percentage: estimate?.percentage,
      estimatedTotalRows: estimate?.estimatedTotalRows,
      elapsedMs: estimate?.elapsedMs ?? msg.durationMs,
    });
  }
}

/**
 * Handle an ingestion completion message from the DuckDB worker.
 * Updates the progress tracker and relays completion to the renderer.
 *
 * @param msg - The completion message from the worker.
 */
export function handleWorkerComplete(msg: {
  readonly jobId: string;
  readonly tableName: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
  }[];
  readonly durationMs: number;
  readonly skippedRows: number;
}): void {
  progressTracker.completeJob(msg.jobId);

  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH_EVENTS.INGESTION_COMPLETE, {
      jobId: msg.jobId,
      status: 'completed',
      tableName: msg.tableName,
      rowCount: msg.rowCount,
      columnCount: msg.columnCount,
      durationMs: msg.durationMs,
      skippedRows: msg.skippedRows,
    });
  }
}

/**
 * Handle a Worker error during ingestion.
 *
 * @param jobId - The failed job ID.
 * @param errorMessage - Error description.
 */
export function handleWorkerError(jobId: string, errorMessage: string): void {
  progressTracker.failJob(jobId);

  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(PUSH_EVENTS.INGESTION_COMPLETE, {
      jobId,
      status: 'failed',
      errorMessage,
    });
  }
}

/**
 * Cancel an active ingestion job.
 *
 * @param jobId - The job to cancel.
 * @returns True if the job was found and cancelled.
 */
export function cancelJob(jobId: string): boolean {
  return progressTracker.cancelJob(jobId);
}
