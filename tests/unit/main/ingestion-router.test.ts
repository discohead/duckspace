import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock functions — available before vi.mock factories execute
// ---------------------------------------------------------------------------

const {
  mockStartJob,
  mockUpdateProgress,
  mockCompleteJob,
  mockFailJob,
  mockEstimateCompletion,
  mockCancelJob,
} = vi.hoisted(() => ({
  mockStartJob: vi.fn(),
  mockUpdateProgress: vi.fn(),
  mockCompleteJob: vi.fn(),
  mockFailJob: vi.fn(),
  mockEstimateCompletion: vi.fn(() => ({
    percentage: 50,
    estimatedTotalRows: 2000,
    elapsedMs: 500,
  })),
  mockCancelJob: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing ingestion-router
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(() => Promise.resolve({ size: 1000 })),
}));

vi.mock('@main/ingestion/format-detector', () => ({
  detectFormat: vi.fn(() => Promise.resolve('csv')),
  generateTableName: vi.fn(() => 'test_table'),
}));

vi.mock('@main/ingestion/progress-tracker', () => ({
  ProgressTracker: vi.fn(() => ({
    startJob: mockStartJob,
    updateProgress: mockUpdateProgress,
    completeJob: mockCompleteJob,
    failJob: mockFailJob,
    estimateCompletion: mockEstimateCompletion,
    cancelJob: mockCancelJob,
  })),
}));

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
}));

vi.mock('node:worker_threads', () => ({
  Worker: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { stat } from 'node:fs/promises';
import type { Worker } from 'node:worker_threads';
import { detectFormat, generateTableName } from '@main/ingestion/format-detector';
import {
  computeStats,
  getProgressTracker,
  getTableNameForSource,
  handleWorkerComplete,
  handleWorkerError,
  importFiles,
  removeSource,
  resetState,
  setMainWindow,
  setWorker,
} from '@main/ingestion/ingestion-router';
import { PUSH_EVENTS } from '@shared/constants';
import { DuckspaceError, ERROR_CODES } from '@shared/errors';
import type { BrowserWindow } from 'electron';

// ---------------------------------------------------------------------------
// Mock Worker and MainWindow factories
// ---------------------------------------------------------------------------

const mockPostMessage = vi.fn();
const mockListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockWorker = {
  postMessage: mockPostMessage,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!mockListeners[event]) mockListeners[event] = [];
    mockListeners[event]?.push(handler);
    return mockWorker;
  }),
  removeListener: vi.fn(),
} as unknown as Worker;

const mockSend = vi.fn();
const mockMainWindow = {
  isDestroyed: vi.fn(() => false),
  webContents: { send: mockSend },
} as unknown as BrowserWindow;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IngestionRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();

    // Restore default mock implementations after tests that override them
    (stat as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve({ size: 1000 }));
    (detectFormat as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.resolve('csv'));
    (generateTableName as ReturnType<typeof vi.fn>).mockImplementation(() => 'test_table');

    // Clear stored listeners
    for (const key of Object.keys(mockListeners)) {
      delete mockListeners[key];
    }
  });

  // -------------------------------------------------------------------------
  // setWorker
  // -------------------------------------------------------------------------
  describe('setWorker()', () => {
    it('registers a message listener on the worker', () => {
      setWorker(mockWorker);

      expect(mockWorker.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('routes valid ingest_file_complete messages to handleWorkerComplete', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      // First import a file to populate jobToDataSourceMap
      const result = await importFiles(['/tmp/test.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      // Simulate a valid ingest_file_complete message through the listener
      const messageHandlers = mockListeners['message'];
      expect(messageHandlers).toBeDefined();
      expect(messageHandlers!.length).toBeGreaterThan(0);

      mockSend.mockClear();

      messageHandlers![0]!({
        type: 'ingest_file_complete',
        jobId,
        tableName: 'test_table',
        rowCount: 100,
        columnCount: 3,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false },
          { name: 'name', type: 'VARCHAR', nullable: true },
          { name: 'value', type: 'DOUBLE', nullable: true },
        ],
        durationMs: 250,
        skippedRows: 0,
      });

      // The handler should relay INGESTION_COMPLETE to the renderer
      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_COMPLETE,
        expect.objectContaining({
          type: 'ingestion:complete',
          jobId,
          status: 'completed',
          rowCount: 100,
        }),
      );
    });

    it('logs console.error for invalid ingest_file_complete messages', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      setWorker(mockWorker);

      const messageHandlers = mockListeners['message'];
      expect(messageHandlers).toBeDefined();

      // Send an invalid ingest_file_complete (missing required fields)
      messageHandlers![0]!({
        type: 'ingest_file_complete',
        // missing jobId, tableName, etc.
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[IngestionRouter] Invalid ingest_file_complete:',
        expect.anything(),
      );

      errorSpy.mockRestore();
    });

    it('routes error messages with known jobId to handleWorkerError', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/test.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      mockSend.mockClear();

      const messageHandlers = mockListeners['message'];
      messageHandlers![0]!({
        type: 'error',
        jobId,
        message: 'Something went wrong',
      });

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_COMPLETE,
        expect.objectContaining({
          type: 'ingestion:complete',
          jobId,
          status: 'failed',
          errorMessage: 'Something went wrong',
        }),
      );
    });

    it('ignores error messages with unknown jobId', () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const messageHandlers = mockListeners['message'];
      messageHandlers![0]!({
        type: 'error',
        jobId: 'unknown-job-id',
        message: 'Should be ignored',
      });

      // Should not send any events since the jobId is not in the map
      expect(mockSend).not.toHaveBeenCalledWith(PUSH_EVENTS.INGESTION_COMPLETE, expect.anything());
    });
  });

  // -------------------------------------------------------------------------
  // importFiles
  // -------------------------------------------------------------------------
  describe('importFiles()', () => {
    it('calls stat, detectFormat, generateTableName, and posts message to worker', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');

      expect(stat).toHaveBeenCalledWith('/tmp/data.csv');
      expect(detectFormat).toHaveBeenCalledWith('/tmp/data.csv');
      expect(generateTableName).toHaveBeenCalledWith('/tmp/data.csv', expect.any(Set));

      expect(result.type).toBe('ingestion:importFiles:response');
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]).toEqual(
        expect.objectContaining({
          filePath: '/tmp/data.csv',
          format: 'csv',
        }),
      );
      expect(result.jobs[0]!.jobId).toEqual(expect.any(String));
      expect(result.jobs[0]!.dataSourceId).toEqual(expect.any(String));
    });

    it('posts ingest_file message to the worker', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ingest_file',
          jobId: result.jobs[0]!.jobId,
          filePath: '/tmp/data.csv',
          format: 'csv',
          tableName: 'test_table',
          options: {},
        }),
      );
    });

    it('starts progress tracking for each file', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');

      expect(mockStartJob).toHaveBeenCalledWith(result.jobs[0]!.jobId, 1000);
    });

    it('sends CATALOG_SOURCE_UPDATED and INGESTION_PROGRESS events to renderer', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.CATALOG_SOURCE_UPDATED,
        expect.objectContaining({
          type: 'catalog:sourceUpdated',
          dataSourceId: result.jobs[0]!.dataSourceId,
          status: 'importing',
        }),
      );

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_PROGRESS,
        expect.objectContaining({
          type: 'ingestion:progress',
          jobId: result.jobs[0]!.jobId,
          dataSourceId: result.jobs[0]!.dataSourceId,
          status: 'running',
          rowsProcessed: 0,
          bytesProcessed: 0,
        }),
      );
    });

    it('maps ENOENT to fileNotFoundError', async () => {
      setWorker(mockWorker);

      const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(enoentError);

      try {
        await importFiles(['/tmp/missing.csv'], 'file_picker');
        expect.fail('Expected importFiles to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DuckspaceError);
        expect((err as DuckspaceError).code).toBe(ERROR_CODES.FILE_NOT_FOUND);
      }
    });

    it('maps EACCES to filePermissionDeniedError', async () => {
      setWorker(mockWorker);

      const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
      (stat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(eaccesError);

      try {
        await importFiles(['/tmp/noperm.csv'], 'file_picker');
        expect.fail('Expected importFiles to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DuckspaceError);
        expect((err as DuckspaceError).code).toBe(ERROR_CODES.PERMISSION_DENIED);
      }
    });

    it('re-throws unknown errors from stat', async () => {
      setWorker(mockWorker);

      const unknownError = new Error('Disk I/O error');
      (stat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unknownError);

      await expect(importFiles(['/tmp/broken.csv'], 'file_picker')).rejects.toThrow(
        'Disk I/O error',
      );
    });

    it('handles multiple files in a single call', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      // generateTableName returns different values on successive calls
      let callCount = 0;
      (generateTableName as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callCount++;
        return `table_${String(callCount)}`;
      });

      const result = await importFiles(['/tmp/a.csv', '/tmp/b.csv', '/tmp/c.csv'], 'file_picker');

      expect(result.jobs).toHaveLength(3);
      expect(stat).toHaveBeenCalledTimes(3);
      expect(detectFormat).toHaveBeenCalledTimes(3);
      expect(mockPostMessage).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // handleWorkerComplete
  // -------------------------------------------------------------------------
  describe('handleWorkerComplete()', () => {
    it('sends INGESTION_COMPLETE event to mainWindow', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      mockSend.mockClear();

      handleWorkerComplete({
        jobId,
        tableName: 'test_table',
        rowCount: 500,
        columnCount: 4,
        columns: [
          { name: 'a', type: 'INTEGER', nullable: false },
          { name: 'b', type: 'VARCHAR', nullable: true },
          { name: 'c', type: 'DOUBLE', nullable: true },
          { name: 'd', type: 'BOOLEAN', nullable: false },
        ],
        durationMs: 300,
        skippedRows: 2,
      });

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_COMPLETE,
        expect.objectContaining({
          type: 'ingestion:complete',
          jobId,
          dataSourceId: result.jobs[0]!.dataSourceId,
          status: 'completed',
          rowCount: 500,
          columnCount: 4,
          durationMs: 300,
        }),
      );
    });

    it('calls progressTracker.completeJob', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      handleWorkerComplete({
        jobId,
        tableName: 'test_table',
        rowCount: 100,
        columnCount: 2,
        columns: [
          { name: 'a', type: 'INTEGER', nullable: false },
          { name: 'b', type: 'VARCHAR', nullable: true },
        ],
        durationMs: 100,
        skippedRows: 0,
      });

      expect(mockCompleteJob).toHaveBeenCalledWith(jobId);
    });

    it('cleans up jobToDataSourceMap after completion', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      // Verify table name mapping exists before completion
      expect(getTableNameForSource(result.jobs[0]!.dataSourceId)).toBe('test_table');

      handleWorkerComplete({
        jobId,
        tableName: 'test_table',
        rowCount: 100,
        columnCount: 1,
        columns: [{ name: 'a', type: 'INTEGER', nullable: false }],
        durationMs: 50,
        skippedRows: 0,
      });

      // Calling handleWorkerComplete again with the same jobId should
      // result in dataSourceId being '' since the job map entry was deleted
      mockSend.mockClear();

      handleWorkerComplete({
        jobId,
        tableName: 'test_table',
        rowCount: 100,
        columnCount: 1,
        columns: [{ name: 'a', type: 'INTEGER', nullable: false }],
        durationMs: 50,
        skippedRows: 0,
      });

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_COMPLETE,
        expect.objectContaining({
          dataSourceId: '', // jobId no longer in map
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleWorkerError
  // -------------------------------------------------------------------------
  describe('handleWorkerError()', () => {
    it('sends failed INGESTION_COMPLETE event to mainWindow', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      mockSend.mockClear();

      handleWorkerError(jobId, 'Parse error on row 42');

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_COMPLETE,
        expect.objectContaining({
          type: 'ingestion:complete',
          jobId,
          dataSourceId: result.jobs[0]!.dataSourceId,
          status: 'failed',
          errorMessage: 'Parse error on row 42',
        }),
      );
    });

    it('calls progressTracker.failJob', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      handleWorkerError(jobId, 'Something failed');

      expect(mockFailJob).toHaveBeenCalledWith(jobId);
    });

    it('cleans up jobToDataSourceMap after error', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const jobId = result.jobs[0]!.jobId;

      handleWorkerError(jobId, 'Failure');

      // Second call should have empty dataSourceId since jobId was removed
      mockSend.mockClear();
      handleWorkerError(jobId, 'Failure again');

      expect(mockSend).toHaveBeenCalledWith(
        PUSH_EVENTS.INGESTION_COMPLETE,
        expect.objectContaining({
          dataSourceId: '',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // computeStats
  // -------------------------------------------------------------------------
  describe('computeStats()', () => {
    it('sends compute_stats message to worker', async () => {
      setWorker(mockWorker);

      const promise = computeStats('my_table', 5);

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'compute_stats',
          tableName: 'my_table',
          topN: 5,
        }),
      );

      // Clean up: simulate a response so the promise resolves
      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'compute_stats_complete',
        tableName: 'my_table',
        columns: [],
        durationMs: 100,
      });

      await promise;
    });

    it('uses default topN of 10 when not specified', async () => {
      setWorker(mockWorker);

      const promise = computeStats('default_topn_table');

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'compute_stats',
          tableName: 'default_topn_table',
          topN: 10,
        }),
      );

      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'compute_stats_complete',
        tableName: 'default_topn_table',
        columns: [],
        durationMs: 50,
      });

      await promise;
    });

    it('resolves on valid compute_stats_complete message', async () => {
      setWorker(mockWorker);

      const promise = computeStats('stats_table');

      // Simulate the response
      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'compute_stats_complete',
        tableName: 'stats_table',
        columns: [
          {
            columnName: 'col1',
            columnType: 'INTEGER',
            rowCount: 100,
            nullCount: 5,
            nullPercentage: 5.0,
            distinctCount: 95,
            min: '1',
            max: '100',
          },
        ],
        durationMs: 250,
      });

      const result = await promise;
      expect(result.type).toBe('compute_stats_complete');
      expect(result.tableName).toBe('stats_table');
      expect(result.columns).toHaveLength(1);
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();

      setWorker(mockWorker);

      const promise = computeStats('slow_table');

      // Advance past the 60s timeout
      vi.advanceTimersByTime(61_000);

      await expect(promise).rejects.toThrow('Timeout waiting for compute_stats response');

      vi.useRealTimers();
    });

    it('rejects on worker error message matching the table name', async () => {
      setWorker(mockWorker);

      const promise = computeStats('error_table');

      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'error',
        message: 'Statistics computation failed for error_table',
      });

      await expect(promise).rejects.toThrow('Statistics computation failed for error_table');
    });

    it('ignores error messages not matching the table name', async () => {
      vi.useFakeTimers();

      setWorker(mockWorker);

      const promise = computeStats('target_table');

      const handler = mockListeners['message'];
      // Send an unrelated error — should NOT resolve or reject the promise
      handler![handler!.length - 1]!({
        type: 'error',
        message: 'Unrelated error for other_table',
      });

      // The promise should still be pending; advance to timeout
      vi.advanceTimersByTime(61_000);
      await expect(promise).rejects.toThrow('Timeout');

      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  // removeSource
  // -------------------------------------------------------------------------
  describe('removeSource()', () => {
    it('sends drop_table message to worker', async () => {
      setWorker(mockWorker);

      const promise = removeSource('ds-123', 'my_table');

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'drop_table',
          tableName: 'my_table',
          isView: false,
        }),
      );

      // Simulate response
      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'drop_table_complete',
        tableName: 'my_table',
      });

      const result = await promise;
      expect(result).toEqual({ success: true, tableName: 'my_table' });
    });

    it('resolves on drop_table_complete message', async () => {
      setWorker(mockWorker);

      const promise = removeSource('ds-456', 'another_table');

      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'drop_table_complete',
        tableName: 'another_table',
      });

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.tableName).toBe('another_table');
    });

    it('resolves immediately when tableName is undefined', async () => {
      setWorker(mockWorker);

      const result = await removeSource('ds-789', undefined);

      expect(result).toEqual({ success: true, tableName: '' });
      // No message should be posted since there's no table to drop
      expect(mockPostMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'drop_table' }),
      );
    });

    it('cleans up dataSourceTableMap', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      // Import a file to populate the map
      const importResult = await importFiles(['/tmp/data.csv'], 'file_picker');
      const dataSourceId = importResult.jobs[0]!.dataSourceId;

      expect(getTableNameForSource(dataSourceId)).toBe('test_table');

      const promise = removeSource(dataSourceId, 'test_table');

      // Simulate drop response
      const handler = mockListeners['message'];
      handler![handler!.length - 1]!({
        type: 'drop_table_complete',
        tableName: 'test_table',
      });

      await promise;

      // Map entry should be gone
      expect(getTableNameForSource(dataSourceId)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // resetState
  // -------------------------------------------------------------------------
  describe('resetState()', () => {
    it('clears all internal maps', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      // Import files to populate maps
      const result = await importFiles(['/tmp/a.csv', '/tmp/b.csv'], 'file_picker');
      const dsId1 = result.jobs[0]!.dataSourceId;
      const dsId2 = result.jobs[1]!.dataSourceId;

      // Verify maps are populated
      expect(getTableNameForSource(dsId1)).toBeDefined();
      expect(getTableNameForSource(dsId2)).toBeDefined();

      // Reset
      resetState();

      // Verify maps are cleared
      expect(getTableNameForSource(dsId1)).toBeUndefined();
      expect(getTableNameForSource(dsId2)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getProgressTracker
  // -------------------------------------------------------------------------
  describe('getProgressTracker()', () => {
    it('returns the progress tracker singleton', () => {
      const tracker = getProgressTracker();
      expect(tracker).toBeDefined();
      expect(tracker.startJob).toBeDefined();
      expect(tracker.completeJob).toBeDefined();
      expect(tracker.failJob).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // getTableNameForSource
  // -------------------------------------------------------------------------
  describe('getTableNameForSource()', () => {
    it('returns undefined for unknown data source', () => {
      expect(getTableNameForSource('nonexistent-id')).toBeUndefined();
    });

    it('returns table name for a known data source', async () => {
      setWorker(mockWorker);
      setMainWindow(mockMainWindow);

      const result = await importFiles(['/tmp/data.csv'], 'file_picker');
      const dsId = result.jobs[0]!.dataSourceId;

      expect(getTableNameForSource(dsId)).toBe('test_table');
    });
  });
});
