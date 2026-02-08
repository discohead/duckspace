/**
 * Zod runtime validation schemas for ingestion and watch directory operations.
 *
 * All schemas use `.strict()` to reject extra fields and `.describe()` for documentation.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enum schemas
// ---------------------------------------------------------------------------

/** Supported file formats for data ingestion. */
export const DataSourceFormatSchema = z
  .enum(['csv', 'tsv', 'parquet', 'json', 'jsonl', 'xlsx', 'arrow_ipc'])
  .describe('Supported file format for data ingestion');

/** Data source lifecycle status. */
export const DataSourceStatusSchema = z
  .enum(['importing', 'active', 'stale', 'error', 'removed'])
  .describe('Data source lifecycle status');

/** Ingestion job lifecycle status. */
export const IngestionJobStatusSchema = z
  .enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
  .describe('Ingestion job lifecycle status');

/** How the import was initiated. */
export const IngestionTriggerSchema = z
  .enum(['file_picker', 'drag_and_drop', 'watch_directory', 'retry'])
  .describe('Ingestion trigger source');

// ---------------------------------------------------------------------------
// Options & request schemas
// ---------------------------------------------------------------------------

/** Options for file ingestion (CSV delimiter, encoding, etc.). */
export const IngestFileOptionsSchema = z
  .object({
    delimiter: z.string().optional(),
    encoding: z.enum(['utf-8', 'latin-1']).optional(),
    header: z.boolean().optional(),
    jsonFormat: z.enum(['auto', 'array', 'newline_delimited', 'unstructured']).optional(),
    sheet: z.union([z.string(), z.number()]).optional(),
    sampleSize: z.number().positive().int().optional(),
    ignoreErrors: z.boolean().optional(),
  })
  .strict()
  .describe('File ingestion options');

/** Request to import one or more files. */
export const ImportFilesRequestSchema = z
  .object({
    filePaths: z.array(z.string().min(1)).min(1),
    trigger: IngestionTriggerSchema,
  })
  .strict()
  .describe('Import files request');

/** Request to cancel an in-progress ingestion job. */
export const CancelJobRequestSchema = z
  .object({
    jobId: z.string().min(1),
  })
  .strict()
  .describe('Cancel ingestion job request');

/** Request to get progress for an active ingestion job. */
export const GetProgressRequestSchema = z
  .object({
    jobId: z.string().min(1),
  })
  .strict()
  .describe('Get ingestion progress request');

// ---------------------------------------------------------------------------
// Record schemas (Dexie.js storage)
// ---------------------------------------------------------------------------

/** Complete ingestion job record for Dexie.js storage. */
export const IngestionJobSchema = z
  .object({
    id: z.string().min(1),
    dataSourceId: z.string().min(1),
    status: IngestionJobStatusSchema,
    filePath: z.string().min(1),
    format: DataSourceFormatSchema,
    fileSizeBytes: z.number().int().nonnegative().optional(),
    rowsProcessed: z.number().int().nonnegative(),
    batchesReceived: z.number().int().nonnegative(),
    bytesProcessed: z.number().int().nonnegative(),
    estimatedTotalRows: z.number().int().nonnegative().optional(),
    errorMessage: z.string().optional(),
    errorCode: z.string().optional(),
    startedAt: z.string().min(1),
    completedAt: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    triggeredBy: IngestionTriggerSchema,
  })
  .strict()
  .describe('Ingestion job record');

/** Watch directory configuration record for Dexie.js storage. */
export const WatchDirectorySchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    displayName: z.string().min(1),
    isActive: z.boolean(),
    recursive: z.boolean(),
    fileTypeFilter: z.array(DataSourceFormatSchema).min(1),
    excludePatterns: z.array(z.string()),
    autoReingest: z.boolean(),
    stabilityThresholdMs: z.number().int().min(500).max(30_000),
    sourceCount: z.number().int().nonnegative(),
    lastScanAt: z.string().optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict()
  .describe('Watch directory configuration');

// ---------------------------------------------------------------------------
// Watch directory request schemas
// ---------------------------------------------------------------------------

/** Request to add a watch directory. */
export const AddWatchDirectoryRequestSchema = z
  .object({
    path: z.string().min(1),
    options: z
      .object({
        recursive: z.boolean().optional(),
        fileTypeFilter: z.array(DataSourceFormatSchema).optional(),
        excludePatterns: z.array(z.string()).optional(),
        autoReingest: z.boolean().optional(),
        stabilityThresholdMs: z.number().int().min(500).max(30_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('Add watch directory request');

/** Request to remove a watch directory. */
export const RemoveWatchDirectoryRequestSchema = z
  .object({
    watchDirectoryId: z.string().min(1),
    removeAssociatedSources: z.boolean().optional(),
  })
  .strict()
  .describe('Remove watch directory request');
