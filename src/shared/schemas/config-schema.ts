/**
 * Zod schema for DuckspaceConfig — runtime validation with clamping transforms.
 *
 * Replaces the manual `validateConfig()` in config.ts.
 * The inferred type is re-exported from `src/shared/types.ts`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const DUCK_DB_CONFIG_SCHEMA = z
  .object({
    memoryLimitPercent: z
      .number()
      .describe('Percentage of system RAM to allocate (clamped 10-90)')
      .transform((v) => Math.max(10, Math.min(90, v))),
    memoryLimitOverrideMB: z
      .number()
      .nullable()
      .describe('Explicit MB override (null = use percent)'),
    threads: z.number().nullable().describe('Thread count (null = os.cpus().length - 2)'),
    extensions: z.array(z.string()).describe('Extensions to load at startup'),
  })
  .strict();

const PATHS_CONFIG_SCHEMA = z
  .object({
    database: z.string().describe('Database filename'),
    tempDir: z.string().describe('Temp/spill directory'),
    config: z.string().describe('Config file (self-reference)'),
  })
  .strict();

const WORKERS_CONFIG_SCHEMA = z
  .object({
    healthCheckIntervalMs: z
      .number()
      .describe('How often to ping workers in ms (>= 5000)')
      .transform((v) => Math.max(5000, v)),
    heartbeatTimeoutMs: z
      .number()
      .describe('Max wait for health check response in ms (>= 1000)')
      .transform((v) => Math.max(1000, v)),
    maxRestartAttempts: z
      .number()
      .describe('Auto-restart limit before marking failed (>= 1)')
      .transform((v) => Math.max(1, v)),
    v8HeapLimitMB: z
      .number()
      .describe('V8 heap limit for worker threads in MB (>= 128)')
      .transform((v) => Math.max(128, v)),
  })
  .strict();

const UI_CONFIG_SCHEMA = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).describe('Color theme').catch('system'),
    fontSize: z
      .number()
      .describe('Base font size in pixels (clamped 10-24)')
      .transform((v) => Math.max(10, Math.min(24, v))),
    defaultQueryLimit: z
      .number()
      .describe('Default LIMIT for unbounded SELECTs (>= 0)')
      .transform((v) => Math.max(0, v)),
  })
  .strict();

const LIFECYCLE_CONFIG_SCHEMA = z
  .object({
    shutdownTimeoutMs: z
      .number()
      .describe('Max time for graceful shutdown in ms (>= 2000)')
      .transform((v) => Math.max(2000, v)),
    walCheckpointOnShutdown: z.boolean().describe('Run CHECKPOINT before closing DuckDB'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the root DuckspaceConfig object.
 *
 * Validates and transforms the full application configuration with clamping
 * for numeric values. Sub-schemas enforce strict mode (no extra keys) and
 * apply minimum-value transforms to prevent invalid configurations.
 */
export const DuckspaceConfigSchema = z
  .object({
    duckdb: DUCK_DB_CONFIG_SCHEMA.describe('DuckDB memory and threading configuration'),
    paths: PATHS_CONFIG_SCHEMA.describe('Application paths (relative to userData)'),
    workers: WORKERS_CONFIG_SCHEMA.describe('Worker health monitoring settings'),
    ui: UI_CONFIG_SCHEMA.describe('UI preferences'),
    lifecycle: LIFECYCLE_CONFIG_SCHEMA.describe('Application lifecycle settings'),
  })
  .strict();

/** Inferred type from the Zod schema — replaces the manual DuckspaceConfig interface */
export type DuckspaceConfig = z.infer<typeof DuckspaceConfigSchema>;
