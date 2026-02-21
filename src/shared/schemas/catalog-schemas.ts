/**
 * Zod runtime validation schemas for catalog management operations.
 *
 * Covers data source CRUD, column statistics, and catalog query filters.
 * All schemas use `.strict()` to reject extra fields and `.describe()` for documentation.
 */

import { z } from 'zod';
import { DataSourceFormatSchema, DataSourceStatusSchema } from './ingestion-schemas';

/** Top-N frequent value entry for categorical column statistics. */
export const TopValueSchema = z
  .object({
    value: z.string(),
    count: z.number().int().nonnegative(),
    percentage: z.number().nonnegative(),
  })
  .strict()
  .describe('Top-N frequent value');

/** Per-column statistics computed by DuckDB SUMMARIZE. */
export const ColumnStatisticsSchema = z
  .object({
    id: z.string().min(1),
    dataSourceId: z.string().min(1),
    columnName: z.string().min(1),
    columnType: z.string().min(1).describe('DuckDB data type (e.g. INTEGER, VARCHAR)'),
    rowCount: z.number().int().nonnegative(),
    nullCount: z.number().int().nonnegative(),
    nullPercentage: z.number().nonnegative(),
    distinctCount: z.number().int().nonnegative(),
    min: z.string().optional(),
    max: z.string().optional(),
    mean: z.number().optional(),
    median: z.number().optional(),
    stddev: z.number().optional(),
    q25: z.number().optional(),
    q75: z.number().optional(),
    topValues: z.array(TopValueSchema).optional(),
    computedAt: z.string().min(1),
  })
  .strict()
  .describe('Per-column statistics');

/** Data source record for Dexie.js storage. */
export const DataSourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(255),
    filePath: z.string().min(1),
    format: DataSourceFormatSchema,
    status: DataSourceStatusSchema,
    duckdbTableName: z.string().optional(),
    duckdbViewName: z.string().optional(),
    rowCount: z.number().int().nonnegative().optional(),
    columnCount: z.number().int().nonnegative().optional(),
    fileSizeBytes: z.number().int().nonnegative().optional(),
    fileModifiedAt: z.string().optional(),
    watchDirectoryId: z.string().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20),
    errorMessage: z.string().optional(),
    errorCode: z.string().optional(),
    sheetName: z.string().optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict()
  .describe('Data source catalog entry');

/** Extended column schema with data source reference. */
export const ColumnSchemaExtendedSchema = z
  .object({
    id: z.string().min(1),
    catalogEntryId: z.string().min(1),
    dataSourceId: z.string().optional(),
    columnName: z.string().min(1),
    columnType: z.string().min(1),
    arrowType: z.string().min(1),
    nullable: z.boolean(),
    ordinalPosition: z.number().int().nonnegative(),
    isNumeric: z.boolean().optional(),
    isCategorical: z.boolean().optional(),
  })
  .strict()
  .describe('Extended column schema with data source reference');

/** Request to get data sources with optional filters. */
export const GetSourcesRequestSchema = z
  .object({
    filters: z
      .object({
        status: z.array(DataSourceStatusSchema).optional(),
        format: z.array(DataSourceFormatSchema).optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('Get data sources request');

/** Request to remove a data source. */
export const RemoveSourceRequestSchema = z
  .object({
    dataSourceId: z.string().min(1),
  })
  .strict()
  .describe('Remove data source request');

/** Request to update a data source's metadata. */
export const UpdateSourceRequestSchema = z
  .object({
    dataSourceId: z.string().min(1),
    updates: z
      .object({
        name: z.string().min(1).max(255).optional(),
        tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      })
      .strict(),
  })
  .strict()
  .describe('Update data source request');

/** Request to compute or retrieve column statistics. */
export const GetColumnStatsRequestSchema = z
  .object({
    dataSourceId: z.string().min(1),
    forceRecompute: z.boolean().optional(),
  })
  .strict()
  .describe('Get column statistics request');
