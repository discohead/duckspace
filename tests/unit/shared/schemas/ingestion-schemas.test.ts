import {
  AddWatchDirectoryRequestSchema,
  CancelJobRequestSchema,
  DataSourceFormatSchema,
  DataSourceStatusSchema,
  GetProgressRequestSchema,
  ImportFilesRequestSchema,
  IngestFileOptionsSchema,
  IngestionJobSchema,
  IngestionJobStatusSchema,
  IngestionTriggerSchema,
  RemoveWatchDirectoryRequestSchema,
  WatchDirectorySchema,
} from '@shared/schemas/ingestion-schemas';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const makeWatchDirectory = (overrides = {}) => ({
  id: 'wd-1',
  path: '/tmp/test',
  displayName: 'test',
  isActive: true,
  recursive: true,
  fileTypeFilter: ['csv'] as const,
  excludePatterns: [],
  autoReingest: false,
  stabilityThresholdMs: 2000,
  sourceCount: 0,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const makeIngestionJob = (overrides = {}) => ({
  id: 'job-1',
  dataSourceId: 'ds-1',
  status: 'running' as const,
  filePath: '/tmp/data.csv',
  format: 'csv' as const,
  rowsProcessed: 0,
  batchesReceived: 0,
  bytesProcessed: 0,
  startedAt: '2024-01-01T00:00:00.000Z',
  triggeredBy: 'file_picker' as const,
  ...overrides,
});

describe('ingestion-schemas', () => {
  // -------------------------------------------------------------------------
  // Enum schemas
  // -------------------------------------------------------------------------

  describe('DataSourceFormatSchema', () => {
    it.each([
      'csv',
      'tsv',
      'parquet',
      'json',
      'jsonl',
      'xlsx',
      'arrow_ipc',
    ])('accepts valid format: %s', (format) => {
      expect(DataSourceFormatSchema.safeParse(format).success).toBe(true);
    });

    it('rejects invalid string', () => {
      expect(DataSourceFormatSchema.safeParse('docx').success).toBe(false);
    });

    it('rejects number', () => {
      expect(DataSourceFormatSchema.safeParse(42).success).toBe(false);
    });
  });

  describe('DataSourceStatusSchema', () => {
    it.each([
      'importing',
      'active',
      'stale',
      'error',
      'removed',
    ])('accepts valid status: %s', (status) => {
      expect(DataSourceStatusSchema.safeParse(status).success).toBe(true);
    });

    it('rejects invalid string', () => {
      expect(DataSourceStatusSchema.safeParse('unknown').success).toBe(false);
    });
  });

  describe('IngestionJobStatusSchema', () => {
    it.each([
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
    ])('accepts valid status: %s', (status) => {
      expect(IngestionJobStatusSchema.safeParse(status).success).toBe(true);
    });

    it('rejects invalid string', () => {
      expect(IngestionJobStatusSchema.safeParse('pending').success).toBe(false);
    });
  });

  describe('IngestionTriggerSchema', () => {
    it.each([
      'file_picker',
      'drag_and_drop',
      'watch_directory',
      'retry',
    ])('accepts valid trigger: %s', (trigger) => {
      expect(IngestionTriggerSchema.safeParse(trigger).success).toBe(true);
    });

    it('rejects invalid string', () => {
      expect(IngestionTriggerSchema.safeParse('manual').success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Options & request schemas
  // -------------------------------------------------------------------------

  describe('IngestFileOptionsSchema', () => {
    it('accepts empty object (all fields optional)', () => {
      expect(IngestFileOptionsSchema.safeParse({}).success).toBe(true);
    });

    it('accepts full valid object', () => {
      const result = IngestFileOptionsSchema.safeParse({
        delimiter: ',',
        encoding: 'utf-8',
        header: true,
        jsonFormat: 'array',
        maxDepth: 5,
        sheet: 'Sheet1',
        sampleSize: 1000,
        ignoreErrors: false,
      });
      expect(result.success).toBe(true);
    });

    it('rejects extra fields (strict)', () => {
      expect(IngestFileOptionsSchema.safeParse({ extra: true }).success).toBe(false);
    });

    it('encoding only accepts utf-8 or latin-1', () => {
      expect(IngestFileOptionsSchema.safeParse({ encoding: 'utf-8' }).success).toBe(true);
      expect(IngestFileOptionsSchema.safeParse({ encoding: 'latin-1' }).success).toBe(true);
      expect(IngestFileOptionsSchema.safeParse({ encoding: 'ascii' }).success).toBe(false);
    });

    it('jsonFormat only accepts valid values', () => {
      for (const valid of ['auto', 'array', 'newline_delimited', 'unstructured']) {
        expect(IngestFileOptionsSchema.safeParse({ jsonFormat: valid }).success).toBe(true);
      }
      expect(IngestFileOptionsSchema.safeParse({ jsonFormat: 'lines' }).success).toBe(false);
    });
  });

  describe('ImportFilesRequestSchema', () => {
    it('accepts valid request', () => {
      const result = ImportFilesRequestSchema.safeParse({
        filePaths: ['/tmp/data.csv'],
        trigger: 'file_picker',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty filePaths array', () => {
      const result = ImportFilesRequestSchema.safeParse({
        filePaths: [],
        trigger: 'file_picker',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty string in filePaths', () => {
      const result = ImportFilesRequestSchema.safeParse({
        filePaths: [''],
        trigger: 'file_picker',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid trigger', () => {
      const result = ImportFilesRequestSchema.safeParse({
        filePaths: ['/tmp/data.csv'],
        trigger: 'cli',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      const result = ImportFilesRequestSchema.safeParse({
        filePaths: ['/tmp/data.csv'],
        trigger: 'file_picker',
        extra: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('CancelJobRequestSchema', () => {
    it('accepts valid request', () => {
      expect(CancelJobRequestSchema.safeParse({ jobId: 'job-1' }).success).toBe(true);
    });

    it('rejects empty jobId', () => {
      expect(CancelJobRequestSchema.safeParse({ jobId: '' }).success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      expect(CancelJobRequestSchema.safeParse({ jobId: 'job-1', extra: true }).success).toBe(false);
    });
  });

  describe('GetProgressRequestSchema', () => {
    it('accepts valid request', () => {
      expect(GetProgressRequestSchema.safeParse({ jobId: 'job-1' }).success).toBe(true);
    });

    it('rejects empty jobId', () => {
      expect(GetProgressRequestSchema.safeParse({ jobId: '' }).success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      expect(GetProgressRequestSchema.safeParse({ jobId: 'job-1', extra: true }).success).toBe(
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Record schemas
  // -------------------------------------------------------------------------

  describe('IngestionJobSchema', () => {
    it('accepts full valid record', () => {
      const result = IngestionJobSchema.safeParse(makeIngestionJob());
      expect(result.success).toBe(true);
    });

    it('accepts with all optional fields', () => {
      const result = IngestionJobSchema.safeParse(
        makeIngestionJob({
          fileSizeBytes: 4096,
          estimatedTotalRows: 10_000,
          errorMessage: 'parse error',
          errorCode: 'E1001',
          completedAt: '2024-01-01T00:01:00.000Z',
          durationMs: 60_000,
        }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects missing required field (id)', () => {
      const { id: _, ...rest } = makeIngestionJob();
      expect(IngestionJobSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects missing required field (dataSourceId)', () => {
      const { dataSourceId: _, ...rest } = makeIngestionJob();
      expect(IngestionJobSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects missing required field (status)', () => {
      const { status: _, ...rest } = makeIngestionJob();
      expect(IngestionJobSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      expect(IngestionJobSchema.safeParse(makeIngestionJob({ bonus: true })).success).toBe(false);
    });

    it('rejects negative rowsProcessed', () => {
      expect(IngestionJobSchema.safeParse(makeIngestionJob({ rowsProcessed: -1 })).success).toBe(
        false,
      );
    });
  });

  describe('WatchDirectorySchema', () => {
    it('accepts full valid record', () => {
      const result = WatchDirectorySchema.safeParse(makeWatchDirectory());
      expect(result.success).toBe(true);
    });

    it('accepts with optional lastScanAt', () => {
      const result = WatchDirectorySchema.safeParse(
        makeWatchDirectory({ lastScanAt: '2024-06-01T12:00:00.000Z' }),
      );
      expect(result.success).toBe(true);
    });

    it('rejects stabilityThresholdMs below 500', () => {
      expect(
        WatchDirectorySchema.safeParse(makeWatchDirectory({ stabilityThresholdMs: 499 })).success,
      ).toBe(false);
    });

    it('accepts stabilityThresholdMs at lower bound (500)', () => {
      expect(
        WatchDirectorySchema.safeParse(makeWatchDirectory({ stabilityThresholdMs: 500 })).success,
      ).toBe(true);
    });

    it('accepts stabilityThresholdMs at upper bound (30000)', () => {
      expect(
        WatchDirectorySchema.safeParse(makeWatchDirectory({ stabilityThresholdMs: 30_000 }))
          .success,
      ).toBe(true);
    });

    it('rejects stabilityThresholdMs above 30000', () => {
      expect(
        WatchDirectorySchema.safeParse(makeWatchDirectory({ stabilityThresholdMs: 30_001 }))
          .success,
      ).toBe(false);
    });

    it('rejects empty fileTypeFilter array', () => {
      expect(
        WatchDirectorySchema.safeParse(makeWatchDirectory({ fileTypeFilter: [] })).success,
      ).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      expect(WatchDirectorySchema.safeParse(makeWatchDirectory({ extra: 'nope' })).success).toBe(
        false,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Watch directory request schemas
  // -------------------------------------------------------------------------

  describe('AddWatchDirectoryRequestSchema', () => {
    it('accepts valid request with options', () => {
      const result = AddWatchDirectoryRequestSchema.safeParse({
        path: '/tmp/watched',
        options: {
          recursive: true,
          fileTypeFilter: ['csv', 'parquet'],
          excludePatterns: ['*.tmp'],
          autoReingest: true,
          stabilityThresholdMs: 3000,
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid request without options', () => {
      const result = AddWatchDirectoryRequestSchema.safeParse({
        path: '/tmp/watched',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty path', () => {
      expect(AddWatchDirectoryRequestSchema.safeParse({ path: '' }).success).toBe(false);
    });

    it('rejects extra fields in nested options (strict)', () => {
      const result = AddWatchDirectoryRequestSchema.safeParse({
        path: '/tmp/watched',
        options: { recursive: true, extra: true },
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields at top level (strict)', () => {
      const result = AddWatchDirectoryRequestSchema.safeParse({
        path: '/tmp/watched',
        extra: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('RemoveWatchDirectoryRequestSchema', () => {
    it('accepts valid request', () => {
      const result = RemoveWatchDirectoryRequestSchema.safeParse({
        watchDirectoryId: 'wd-1',
      });
      expect(result.success).toBe(true);
    });

    it('accepts with optional removeAssociatedSources', () => {
      const result = RemoveWatchDirectoryRequestSchema.safeParse({
        watchDirectoryId: 'wd-1',
        removeAssociatedSources: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty watchDirectoryId', () => {
      expect(RemoveWatchDirectoryRequestSchema.safeParse({ watchDirectoryId: '' }).success).toBe(
        false,
      );
    });

    it('rejects extra fields (strict)', () => {
      expect(
        RemoveWatchDirectoryRequestSchema.safeParse({
          watchDirectoryId: 'wd-1',
          extra: true,
        }).success,
      ).toBe(false);
    });
  });
});
