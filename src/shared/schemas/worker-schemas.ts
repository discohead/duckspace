/**
 * Zod runtime validation schemas for Worker control messages.
 *
 * These schemas mirror the TypeScript types in `src/shared/types.ts` (section 3)
 * and are used to validate messages flowing over parentPort between
 * Main Process and DuckDB Worker Thread.
 */

import { z } from 'zod';
import { DataSourceFormatSchema, IngestFileOptionsSchema } from './ingestion-schemas';

// ============================================================
// Shared field schemas
// ============================================================

const COLUMN_SCHEMA_Z = z
  .object({
    name: z.string(),
    duckdbType: z.string(),
    arrowType: z.string(),
    nullable: z.boolean(),
    ordinalPosition: z.number().int(),
  })
  .strict()
  .describe('Column schema information');

// ============================================================
// Main -> Worker messages
// ============================================================

/**
 * Schema for query execution requests sent from Main to Worker.
 * Validates SQL string, optional parameters, and execution options (timeout, batchSize, readOnly).
 */
export const WorkerQueryRequestSchema = z
  .object({
    type: z.literal('execute_query'),
    queryId: z.string(),
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
    options: z
      .object({
        timeout: z.number().positive().optional(),
        batchSize: z.number().positive().int().optional(),
        readOnly: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('Main -> Worker: Execute SQL query');

/**
 * Schema for query cancellation requests sent from Main to Worker.
 * Validates the queryId of the running query to cancel.
 */
export const WorkerCancelRequestSchema = z
  .object({
    type: z.literal('cancel_query'),
    queryId: z.string(),
  })
  .strict()
  .describe('Main -> Worker: Cancel a running query');

/**
 * Schema for table info requests sent from Main to Worker.
 * Validates the tableName to describe.
 */
export const WorkerGetTableInfoRequestSchema = z
  .object({
    type: z.literal('get_table_info'),
    tableName: z.string(),
  })
  .strict()
  .describe('Main -> Worker: Get table information');

/**
 * Schema for list-all-tables requests sent from Main to Worker.
 */
export const WorkerListTablesRequestSchema = z
  .object({
    type: z.literal('list_tables'),
  })
  .strict()
  .describe('Main -> Worker: List all tables');

/**
 * Schema for graceful shutdown requests sent from Main to Worker.
 */
export const ShutdownRequestSchema = z
  .object({
    type: z.literal('shutdown'),
  })
  .strict()
  .describe('Main -> Worker: Request graceful shutdown');

/**
 * Schema for runtime configuration updates sent from Main to Worker.
 * Validates optional memory_limit, threads, and temp_directory settings.
 */
export const WorkerConfigUpdateSchema = z
  .object({
    type: z.literal('configure'),
    settings: z
      .object({
        memory_limit: z.string().optional(),
        threads: z.number().positive().int().optional(),
        temp_directory: z.string().optional(),
      })
      .strict(),
  })
  .strict()
  .describe('Main -> Worker: Update runtime configuration');

/**
 * Schema for health check requests sent from Main to Worker.
 */
export const WorkerHealthCheckSchema = z
  .object({
    type: z.literal('health_check'),
  })
  .strict()
  .describe('Main -> Worker: Health check');

/**
 * Schema for heartbeat ping requests sent from Main to Worker.
 * Includes a sentAt timestamp for round-trip latency measurement.
 */
export const HeartbeatRequestSchema = z
  .object({
    type: z.literal('heartbeat'),
    sentAt: z.number(),
  })
  .strict()
  .describe('Main -> Worker: Heartbeat ping');

/**
 * Schema for MessagePort setup messages sent from Main to Worker.
 * Not part of the WorkerMessage union in types.ts; the port field cannot be validated by Zod.
 */
export const PortSetupMessageSchema = z
  .object({
    type: z.literal('port'),
    channel: z.literal('duckdb-data'),
    port: z.unknown(), // MessagePort cannot be validated by Zod
  })
  .describe('Main -> Worker: MessagePort setup');

// ============================================================
// Worker -> Main messages
// ============================================================

/**
 * Schema for table info responses sent from Worker to Main.
 * Includes column schemas, row count, and size in bytes.
 */
export const WorkerGetTableInfoResponseSchema = z
  .object({
    type: z.literal('table_info'),
    tableName: z.string(),
    columns: z.array(COLUMN_SCHEMA_Z),
    rowCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Worker -> Main: Table info response');

/**
 * Schema for catalog update notifications sent from Worker to Main after table registration.
 * Includes full column schema, row count, size, and registration type (table/view).
 */
export const WorkerCatalogUpdateSchema = z
  .object({
    type: z.literal('catalog_update'),
    table: z.string(),
    columns: z.array(COLUMN_SCHEMA_Z),
    rowCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    sourceId: z.string(),
    registrationType: z.enum(['table', 'view']),
  })
  .strict()
  .describe('Worker -> Main: Catalog update after table registration');

/**
 * Schema for the worker ready signal sent from Worker to Main after initialization.
 * Optionally includes DuckDB version, loaded extensions, and initial table count.
 */
export const WorkerReadyMessageSchema = z
  .object({
    type: z.literal('ready'),
    worker: z.literal('duckdb'),
    metadata: z
      .object({
        duckdbVersion: z.string().optional(),
        extensionsLoaded: z.array(z.string()).optional(),
        tableCount: z.number().int().nonnegative().optional(),
        integrityOk: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('Worker -> Main: Initialization complete');

/**
 * Schema for the shutdown complete acknowledgment sent from Worker to Main.
 */
export const ShutdownCompleteSchema = z
  .object({
    type: z.literal('shutdown-complete'),
    worker: z.literal('duckdb'),
  })
  .strict()
  .describe('Worker -> Main: Shutdown complete');

/**
 * Schema for health check responses sent from Worker to Main.
 * Reports status (healthy/degraded/failed), table count, memory usage, and active queries.
 */
export const WorkerHealthResponseSchema = z
  .object({
    type: z.literal('health_check_result'),
    status: z.enum(['healthy', 'degraded', 'failed']),
    tables: z.number().int().nonnegative(),
    memoryUsedMB: z.number().nonnegative(),
    activeQueries: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Worker -> Main: Health check response');

/**
 * Schema for heartbeat acknowledgments sent from Worker to Main.
 * Echoes back the sentAt timestamp and reports current worker status and metrics.
 */
export const HeartbeatAckSchema = z
  .object({
    type: z.literal('heartbeat_ack'),
    sentAt: z.number(),
    status: z.enum(['healthy', 'degraded', 'busy']),
    details: z
      .object({
        activeQueries: z.number().int().nonnegative().optional(),
        memoryUsageMB: z.number().nonnegative().optional(),
        uptime: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe('Worker -> Main: Heartbeat response');

/**
 * Schema for unhandled error messages sent from Worker to Main.
 */
export const WorkerErrorMessageSchema = z
  .object({
    type: z.literal('error'),
    message: z.string(),
    jobId: z.string().optional(),
  })
  .strict()
  .describe('Worker -> Main: Unhandled error');

/**
 * Schema for MessagePort ready acknowledgments sent from Worker to Main.
 * Confirms the data plane channel is open and ready for Arrow IPC transfers.
 */
export const PortReadyMessageSchema = z
  .object({
    type: z.literal('port-ready'),
    channel: z.literal('duckdb-data'),
  })
  .strict()
  .describe('Worker -> Main: MessagePort ready acknowledgment');

/**
 * Schema for table list responses sent from Worker to Main.
 * Contains an array of table metadata objects with name, schema, type, row count, and size.
 */
export const WorkerTableListResponseSchema = z
  .object({
    type: z.literal('table_list'),
    tables: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        schema: z.string(),
        type: z.string(),
        status: z.string(),
        rowCount: z.number().int().nonnegative(),
        sizeBytes: z.number().int().nonnegative(),
        columnCount: z.number().int().nonnegative(),
        registeredAt: z.string(),
      }),
    ),
  })
  .strict()
  .describe('Worker -> Main: List of tables');

/**
 * Schema for query history records sent from Worker to Main for forwarding to Renderer.
 * Includes execution time, row count, status, and optional error message.
 */
export const QueryHistoryRecordMessageSchema = z
  .object({
    type: z.literal('query_history_record'),
    queryId: z.string(),
    sql: z.string(),
    executionTimeMs: z.number().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    status: z.enum(['success', 'error']),
    errorMessage: z.string().optional(),
  })
  .strict()
  .describe('Worker -> Main: Query history record for renderer');

// ============================================================
// Ingestion: Main -> Worker messages
// ============================================================

/** Schema for file ingestion requests. */
export const WorkerIngestFileRequestSchema = z
  .object({
    type: z.literal('ingest_file'),
    jobId: z.string(),
    filePath: z.string(),
    format: DataSourceFormatSchema,
    tableName: z.string(),
    options: IngestFileOptionsSchema,
  })
  .strict()
  .describe('Main -> Worker: Ingest a file into DuckDB');

/** Schema for file preview requests. */
export const WorkerPreviewFileRequestSchema = z
  .object({
    type: z.literal('preview_file'),
    filePath: z.string(),
    format: DataSourceFormatSchema,
    viewName: z.string(),
    options: IngestFileOptionsSchema,
  })
  .strict()
  .describe('Main -> Worker: Create a preview view over a file');

/** Schema for column statistics computation requests. */
export const WorkerComputeStatsRequestSchema = z
  .object({
    type: z.literal('compute_stats'),
    tableName: z.string(),
    columns: z.array(z.string()).optional(),
    topN: z.number().int().positive().optional(),
  })
  .strict()
  .describe('Main -> Worker: Compute column statistics');

/** Schema for table/view drop requests. */
export const WorkerDropTableRequestSchema = z
  .object({
    type: z.literal('drop_table'),
    tableName: z.string(),
    isView: z.boolean(),
  })
  .strict()
  .describe('Main -> Worker: Drop a table or view');

/** Schema for extension installation requests. */
export const WorkerInstallExtensionRequestSchema = z
  .object({
    type: z.literal('install_extension'),
    extensionName: z.string().regex(/^[\w]+$/u, 'Extension name must contain only word characters'),
    source: z.enum(['core', 'community']).optional(),
  })
  .strict()
  .describe('Main -> Worker: Install a DuckDB extension');

/** Schema for CSV sniffer requests. */
export const WorkerSniffCsvRequestSchema = z
  .object({
    type: z.literal('sniff_csv'),
    filePath: z.string(),
  })
  .strict()
  .describe('Main -> Worker: Sniff CSV dialect');

// ============================================================
// Ingestion: Worker -> Main messages
// ============================================================

/** Schema for ingestion progress updates. */
export const WorkerIngestFileProgressSchema = z
  .object({
    type: z.literal('ingest_file_progress'),
    jobId: z.string(),
    rowsProcessed: z.number().int().nonnegative(),
    bytesProcessed: z.number().int().nonnegative(),
    batchIndex: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  })
  .strict()
  .describe('Worker -> Main: Ingestion progress update');

const WORKER_COLUMN_INFO_Z = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean(),
});

/** Schema for ingestion completion messages. */
export const WorkerIngestFileCompleteSchema = z
  .object({
    type: z.literal('ingest_file_complete'),
    jobId: z.string(),
    tableName: z.string(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    columns: z.array(WORKER_COLUMN_INFO_Z),
    durationMs: z.number().nonnegative(),
    skippedRows: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Worker -> Main: Ingestion complete');

/** Schema for preview completion messages. */
export const WorkerPreviewFileCompleteSchema = z
  .object({
    type: z.literal('preview_file_complete'),
    viewName: z.string(),
    columns: z.array(WORKER_COLUMN_INFO_Z),
    estimatedRowCount: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Worker -> Main: Preview complete');

const WORKER_COLUMN_STATS_Z = z.object({
  columnName: z.string(),
  columnType: z.string(),
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
  topValues: z
    .array(z.object({ value: z.string(), count: z.number().int().nonnegative() }))
    .optional(),
});

/** Schema for column statistics completion messages. */
export const WorkerComputeStatsCompleteSchema = z
  .object({
    type: z.literal('compute_stats_complete'),
    tableName: z.string(),
    columns: z.array(WORKER_COLUMN_STATS_Z),
    durationMs: z.number().nonnegative(),
  })
  .strict()
  .describe('Worker -> Main: Column statistics complete');

/** Schema for table drop completion messages. */
export const WorkerDropTableCompleteSchema = z
  .object({
    type: z.literal('drop_table_complete'),
    tableName: z.string(),
  })
  .strict()
  .describe('Worker -> Main: Table dropped');

/** Schema for extension installation completion messages. */
export const WorkerInstallExtensionCompleteSchema = z
  .object({
    type: z.literal('install_extension_complete'),
    extensionName: z.string(),
    loaded: z.boolean(),
    errorMessage: z.string().optional(),
  })
  .strict()
  .describe('Worker -> Main: Extension installed');

/** Schema for CSV sniffer completion messages. */
export const WorkerSniffCsvCompleteSchema = z
  .object({
    type: z.literal('sniff_csv_complete'),
    filePath: z.string(),
    delimiter: z.string(),
    quoteChar: z.string(),
    escapeChar: z.string(),
    hasHeader: z.boolean(),
    newlineDelimiter: z.string(),
    columns: z.array(z.object({ name: z.string(), type: z.string() })),
    dateFormat: z.string().optional(),
    timestampFormat: z.string().optional(),
  })
  .strict()
  .describe('Worker -> Main: CSV sniff results');

// ============================================================
// Discriminated unions
// ============================================================

/**
 * Discriminated union of all messages the DuckDB Worker can receive from Main via parentPort.
 * Discriminates on the `type` field.
 */
export const WorkerInboundMessageSchema = z
  .discriminatedUnion('type', [
    WorkerQueryRequestSchema,
    WorkerCancelRequestSchema,
    WorkerGetTableInfoRequestSchema,
    WorkerListTablesRequestSchema,
    ShutdownRequestSchema,
    WorkerConfigUpdateSchema,
    WorkerHealthCheckSchema,
    HeartbeatRequestSchema,
    WorkerIngestFileRequestSchema,
    WorkerPreviewFileRequestSchema,
    WorkerComputeStatsRequestSchema,
    WorkerDropTableRequestSchema,
    WorkerInstallExtensionRequestSchema,
    WorkerSniffCsvRequestSchema,
  ])
  .describe('Union of all messages the DuckDB Worker receives from Main');

/**
 * Discriminated union of all messages the DuckDB Worker sends to Main via parentPort.postMessage.
 * Discriminates on the `type` field.
 */
export const WorkerOutboundMessageSchema = z
  .discriminatedUnion('type', [
    WorkerGetTableInfoResponseSchema,
    WorkerCatalogUpdateSchema,
    WorkerReadyMessageSchema,
    ShutdownCompleteSchema,
    WorkerHealthResponseSchema,
    HeartbeatAckSchema,
    WorkerErrorMessageSchema,
    PortReadyMessageSchema,
    WorkerTableListResponseSchema,
    QueryHistoryRecordMessageSchema,
    WorkerIngestFileProgressSchema,
    WorkerIngestFileCompleteSchema,
    WorkerPreviewFileCompleteSchema,
    WorkerComputeStatsCompleteSchema,
    WorkerDropTableCompleteSchema,
    WorkerInstallExtensionCompleteSchema,
    WorkerSniffCsvCompleteSchema,
  ])
  .describe('Union of all messages the DuckDB Worker sends to Main');

// ============================================================
// Inferred types (for use alongside the schemas)
// ============================================================

/** Inferred TypeScript type for all inbound worker messages. */
export type WorkerInboundMessage = z.infer<typeof WorkerInboundMessageSchema>;

/** Inferred TypeScript type for all outbound worker messages. */
export type WorkerOutboundMessage = z.infer<typeof WorkerOutboundMessageSchema>;
