/**
 * Zod schemas for IPC request/response validation.
 *
 * Covers the key control-plane messages flowing over ipcMain.handle channels.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query channels
// ---------------------------------------------------------------------------

/**
 * Zod schema for `query:execute` request payload.
 *
 * Validates the SQL string (must be non-empty) and optional positional parameters.
 */
export const QueryExecuteRequestSchema = z
  .object({
    sql: z.string().min(1).describe('SQL string with $1, $2, ... parameter placeholders'),
    params: z.array(z.unknown()).optional().describe('Parameter values for binding (positional)'),
  })
  .strict();

/**
 * Zod schema for `query:cancel` request payload.
 *
 * Validates the queryId string (must be non-empty) used to identify the running query.
 */
export const QueryCancelRequestSchema = z
  .object({
    queryId: z.string().min(1).describe('The queryId returned by query:execute'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Catalog channels
// ---------------------------------------------------------------------------

/**
 * Zod schema for `query:describeTable` request payload.
 *
 * Validates the table name string used to retrieve column schema information.
 */
export const CatalogDescribeRequestSchema = z
  .object({
    tableName: z.string().min(1).describe('DuckDB table or view name'),
  })
  .strict();

/**
 * Zod schema for `catalog:preview` request payload.
 *
 * Validates the table name and optional row limit for previewing table data.
 */
export const CatalogPreviewRequestSchema = z
  .object({
    tableName: z.string().min(1).describe('DuckDB table or view name'),
    limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of sample rows (default: 100)'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Config channels
// ---------------------------------------------------------------------------

/**
 * Zod schema for `config:get` request payload.
 *
 * Validates the dot-notated config key (e.g., "ui.theme", "duckdb.threads").
 */
export const ConfigGetRequestSchema = z
  .object({
    key: z.string().min(1).describe('Dot-notated config key (e.g., "ui.theme")'),
  })
  .strict();

/**
 * Zod schema for `config:set` request payload.
 *
 * Validates the dot-notated config key and the new value to apply.
 */
export const ConfigSetRequestSchema = z
  .object({
    key: z.string().min(1).describe('Dot-notated config key (e.g., "ui.theme")'),
    value: z.unknown().describe('New value for the config key'),
  })
  .strict();
