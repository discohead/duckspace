import type { DuckDBValue } from '@duckdb/node-api';
import {
  PortSetupMessageSchema,
  type WorkerComputeStatsRequestSchema,
  type WorkerDropTableRequestSchema,
  WorkerInboundMessageSchema,
  type WorkerIngestFileRequestSchema,
  type WorkerInstallExtensionRequestSchema,
  type WorkerPreviewFileRequestSchema,
  type WorkerSniffCsvRequestSchema,
} from '@shared/schemas/worker-schemas';
import type {
  DataSourceFormat,
  HeartbeatAck,
  HeartbeatRequest,
  IngestFileOptions,
  WorkerCancelRequest,
  WorkerConfigUpdate,
  WorkerGetTableInfoRequest,
  WorkerHealthResponse,
  WorkerQueryRequest,
} from '@shared/types';
import { type MessagePort, parentPort, workerData } from 'worker_threads';
import type { z } from 'zod';
import {
  closeDuckDB,
  type DuckDBConfig,
  getConnection,
  initDuckDB,
  runIntegrityCheck,
} from './duckdb-connection';

/** Inferred type for ingest_file requests */
type WorkerIngestFileRequest = z.infer<typeof WorkerIngestFileRequestSchema>;
/** Inferred type for preview_file requests */
type WorkerPreviewFileRequest = z.infer<typeof WorkerPreviewFileRequestSchema>;
/** Inferred type for sniff_csv requests */
type WorkerSniffCsvRequest = z.infer<typeof WorkerSniffCsvRequestSchema>;
/** Inferred type for compute_stats requests */
type WorkerComputeStatsRequest = z.infer<typeof WorkerComputeStatsRequestSchema>;
/** Inferred type for drop_table requests */
type WorkerDropTableRequest = z.infer<typeof WorkerDropTableRequestSchema>;
/** Inferred type for install_extension requests */
type WorkerInstallExtensionRequest = z.infer<typeof WorkerInstallExtensionRequestSchema>;

if (!parentPort) {
  throw new Error('duckdb-worker must run as a Worker Thread');
}
const port = parentPort;

let dataPort: MessagePort | null = null;
const activeQueries = new Map<string, { cancelled: boolean }>();
let startTime = Date.now();

// ---------------------------------------------------------------------------
// Query serialization mutex
// ---------------------------------------------------------------------------
// The DuckDB Node-API connection does NOT support concurrent `conn.run()` calls.
// Because `port.on('message', async handler)` does NOT serialize handler
// invocations (each message starts the handler independently, and when one
// handler yields at `await`, the next can start), two overlapping `conn.run()`
// calls cause a nanoarrow SIGTRAP crash. This mutex ensures at most one
// DuckDB operation runs at a time.
let mutexTail: Promise<void> = Promise.resolve();

/**
 * Enqueue an async operation so it runs after all previously enqueued work.
 * Non-DuckDB messages (port setup, heartbeat) bypass the mutex.
 */
function serialise<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutexTail.then(fn, fn);
  // Update the tail but suppress unhandled-rejection warnings — errors are
  // caught inside each handler and posted back as error messages.
  mutexTail = next.then(
    () => {},
    () => {},
  );
  return next;
}

/**
 * SQL prefixes that must NOT be wrapped in `to_arrow_ipc()`.
 * Covers DDL, DML (non-SELECT), and utility statements.
 */
const NON_SELECT_PREFIX =
  /^\s*(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|COPY|EXPORT|IMPORT|SET|PRAGMA|ATTACH|DETACH|LOAD|INSTALL|BEGIN|COMMIT|ROLLBACK|VACUUM|CHECKPOINT)\b/i;

/** Returns `true` when the SQL should be executed directly without Arrow IPC wrapping. */
function isNonSelectStatement(sql: string): boolean {
  return NON_SELECT_PREFIX.test(sql);
}

/** Strips the `SELECT * FROM to_arrow_ipc((...))` wrapper from DuckDB error messages. */
function stripArrowIpcWrapper(message: string): string {
  return message.replace(/SELECT \* FROM to_arrow_ipc\(\(([\s\S]*?)\)\)/g, '$1');
}

// Handle all incoming messages with Zod validation
// eslint-disable-next-line @typescript-eslint/no-misused-promises
port.on('message', async (msg: { type: string; [key: string]: unknown }) => {
  try {
    // Port setup message (not part of WorkerMessage union — separate schema)
    if (msg.type === 'port') {
      const portResult = PortSetupMessageSchema.safeParse(msg);
      if (!portResult.success) {
        console.error('Invalid port setup message:', portResult.error.issues);
        return;
      }
      dataPort = msg['port'] as MessagePort;
      port.postMessage({ type: 'port-ready', channel: 'duckdb-data' });
      return;
    }

    // Validate all other inbound messages against the discriminated union
    const parsed = WorkerInboundMessageSchema.safeParse(msg);
    if (!parsed.success) {
      console.error('Invalid worker message:', parsed.error.issues);
      port.postMessage({
        type: 'error',
        message: `Invalid message: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      });
      return;
    }

    const validated = parsed.data;
    switch (validated.type) {
      // --- Non-DuckDB handlers: bypass mutex ---
      case 'cancel_query':
        handleCancelQuery(validated);
        break;
      case 'heartbeat':
        handleHeartbeat(validated);
        break;

      // --- DuckDB handlers: serialised via mutex ---
      case 'execute_query':
        await serialise(() => handleExecuteQuery(validated));
        break;
      case 'get_table_info':
        await serialise(() => handleGetTableInfo(validated));
        break;
      case 'list_tables':
        await serialise(() => handleListTables());
        break;
      case 'health_check':
        await serialise(() => handleHealthCheck());
        break;
      case 'configure':
        await serialise(() => handleConfigure(validated));
        break;
      case 'shutdown':
        await serialise(() => handleShutdown());
        break;
      case 'ingest_file':
        await serialise(() => handleIngestFile(validated));
        break;
      case 'preview_file':
        await serialise(() => handlePreviewFile(validated));
        break;
      case 'sniff_csv':
        await serialise(() => handleSniffCsv(validated));
        break;
      case 'compute_stats':
        await serialise(() => handleComputeStats(validated));
        break;
      case 'drop_table':
        await handleDropTable(validated);
        break;
      case 'install_extension':
        await handleInstallExtension(validated);
        break;
    }
  } catch (error) {
    port.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Execute a DDL/DML/utility statement directly (no Arrow IPC wrapping). */
async function handleNonSelectQuery(
  queryId: string,
  sql: string,
  params: unknown[] | undefined,
  startMs: number,
): Promise<void> {
  const conn = getConnection();
  await (params && params.length > 0 ? conn.run(sql, params as DuckDBValue[]) : conn.run(sql));

  const executionTimeMs = Date.now() - startMs;

  sendDataPlaneMessage({
    type: 'arrow-end',
    queryId,
    totalBatches: 0,
    totalRows: 0,
    totalBytes: 0,
    durationMs: executionTimeMs,
    statusMessage: 'Statement executed successfully.',
  });

  // Record in query history (best effort)
  try {
    const escapedSql = sql.replace(/'/g, "''");
    await conn.run(
      `INSERT INTO _query_history (query_id, sql, execution_time_ms, row_count, status, tags)
       VALUES ('${queryId}', '${escapedSql}', ${executionTimeMs}, 0, 'success', [])`,
    );
  } catch (histErr) {
    console.warn(
      'Failed to insert query history (DDL):',
      histErr instanceof Error ? histErr.message : String(histErr),
    );
  }

  port.postMessage({
    type: 'query_history_record',
    queryId,
    sql,
    executionTimeMs,
    rowCount: 0,
    status: 'success',
  });
}

async function handleExecuteQuery(req: WorkerQueryRequest): Promise<void> {
  const { queryId, sql, params } = req;
  activeQueries.set(queryId, { cancelled: false });
  const startMs = Date.now();

  try {
    // QA-002: Execute DDL/DML/utility statements directly without Arrow IPC wrapping
    if (isNonSelectStatement(sql)) {
      await handleNonSelectQuery(queryId, sql, params, startMs);
      return;
    }

    const conn = getConnection();
    const queryState = activeQueries.get(queryId);

    // Use conn.run() (not conn.stream()) for to_arrow_ipc() queries.
    // See: https://github.com/paleolimbot/duckdb-nanoarrow/issues/43
    // The nanoarrow extension crashes (SIGTRAP in ArrowScalarData::Initialize)
    // when allocating Arrow buffers for wide tables at high row counts in Electron.
    // Both conn.run() and conn.stream() trigger the crash — it's in the nanoarrow
    // extension's ArrowAppender constructor, not the execution mode.
    // The DEFAULT_PREVIEW_LIMIT (10k) keeps us safely below the crash threshold.
    const wrappedSql = `SELECT * FROM to_arrow_ipc((${sql}))`;
    const result =
      params && params.length > 0
        ? await conn.run(wrappedSql, params as DuckDBValue[])
        : await conn.run(wrappedSql);

    // Collect all IPC chunks (row 0 = schema, row 1+ = record batches).
    // Must be concatenated into a single buffer for Perspective.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const rows = await result.getRows();
    for (const row of rows) {
      if (queryState?.cancelled) break;
      const val = row[0];
      if (val && typeof val === 'object' && 'bytes' in val) {
        const bytes = (val as { bytes: Uint8Array }).bytes;
        chunks.push(bytes);
        totalBytes += bytes.byteLength;
      }
    }

    if (totalBytes > 0) {
      const buffer = new ArrayBuffer(totalBytes);
      const view = new Uint8Array(buffer);
      let offset = 0;
      for (const chunk of chunks) {
        view.set(chunk, offset);
        offset += chunk.byteLength;
      }

      sendDataPlaneTransfer(
        { type: 'arrow-batch', queryId, index: 0, rowCount: 0, byteSize: totalBytes },
        buffer,
      );
    }

    sendDataPlaneMessage({
      type: 'arrow-end',
      queryId,
      totalBatches: totalBytes > 0 ? 1 : 0,
      totalRows: 0,
      totalBytes,
      durationMs: Date.now() - startMs,
    });

    // Record in query history (best effort)
    const executionTimeMs = Date.now() - startMs;
    try {
      const escapedSql = sql.replace(/'/g, "''");
      await conn.run(
        `INSERT INTO _query_history (query_id, sql, execution_time_ms, row_count, status, tags)
         VALUES ('${queryId}', '${escapedSql}', ${executionTimeMs}, 0, 'success', [])`,
      );
    } catch (histErr) {
      console.warn(
        'Failed to insert query history (success):',
        histErr instanceof Error ? histErr.message : String(histErr),
      );
    }

    // T067: Forward query history record to renderer via Main
    port.postMessage({
      type: 'query_history_record',
      queryId,
      sql,
      executionTimeMs,
      rowCount: 0,
      status: 'success',
    });
  } catch (error) {
    const rawErrMsg = error instanceof Error ? error.message : String(error);
    // QA-003: Strip to_arrow_ipc() wrapper from user-facing error messages
    const errMsg = stripArrowIpcWrapper(rawErrMsg);
    sendDataPlaneMessage({
      type: 'arrow-error',
      queryId,
      code: classifyErrorCode(errMsg),
      message: errMsg,
      batchesSent: 0,
    });

    const errorExecutionTimeMs = Date.now() - startMs;
    try {
      const conn = getConnection();
      const escapedSql = sql.replace(/'/g, "''");
      const escapedErr = errMsg.replace(/'/g, "''");
      await conn.run(
        `INSERT INTO _query_history (query_id, sql, execution_time_ms, row_count, status, error_message, tags)
         VALUES ('${queryId}', '${escapedSql}', ${errorExecutionTimeMs}, 0, 'error', '${escapedErr}', [])`,
      );
    } catch (histErr) {
      console.warn(
        'Failed to insert query history (error):',
        histErr instanceof Error ? histErr.message : String(histErr),
      );
    }

    // T067: Forward query history record to renderer via Main
    port.postMessage({
      type: 'query_history_record',
      queryId,
      sql,
      executionTimeMs: errorExecutionTimeMs,
      rowCount: 0,
      status: 'error',
      errorMessage: errMsg,
    });
  } finally {
    activeQueries.delete(queryId);
  }
}

function handleCancelQuery(req: WorkerCancelRequest): void {
  const queryState = activeQueries.get(req.queryId);
  if (queryState) {
    queryState.cancelled = true;
  }
}

async function handleListTables(): Promise<void> {
  const conn = getConnection();
  const result = await conn.run(`
    SELECT table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = 'main' AND table_name NOT LIKE '\\_\\_%' ESCAPE '\\'
    ORDER BY table_name
  `);
  const rows = await result.getRows();

  const tables = [];
  for (const row of rows) {
    const tableName = row[0] as string;
    const tableType = (row[1] as string).toLowerCase().includes('view') ? 'view' : 'table';

    let columnCount = 0;
    let rowCount = 0;
    const sizeBytes = 0;
    try {
      const colCountResult = await conn.run(`
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = 'main' AND table_name = '${tableName.replace(/'/g, "''")}'
      `);
      const colCountRows = await colCountResult.getRows();
      columnCount = Number(colCountRows[0]?.[0] ?? 0);

      const rowCountResult = await conn.run(`SELECT COUNT(*) FROM "${tableName}"`);
      const rowCountRows = await rowCountResult.getRows();
      rowCount = Number(rowCountRows[0]?.[0] ?? 0);
    } catch (metaErr) {
      console.warn(
        `Failed to get table metadata for "${tableName}":`,
        metaErr instanceof Error ? metaErr.message : String(metaErr),
      );
    }

    tables.push({
      id: `catalog-${tableName}`,
      name: tableName,
      schema: 'main',
      type: tableType,
      status: 'active',
      rowCount,
      sizeBytes,
      columnCount,
      registeredAt: new Date().toISOString(),
    });
  }

  port.postMessage({ type: 'table_list', tables });
}

async function handleGetTableInfo(msg: WorkerGetTableInfoRequest): Promise<void> {
  const conn = getConnection();
  const escapedName = msg.tableName.replace(/'/g, "''");

  const colResult = await conn.run(`
    SELECT column_name, data_type, is_nullable = 'YES' AS nullable, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'main' AND table_name = '${escapedName}'
    ORDER BY ordinal_position
  `);
  const colRows = await colResult.getRows();

  const columns = colRows.map((row: unknown[]) => ({
    name: row[0] as string,
    duckdbType: row[1] as string,
    arrowType: mapDuckDbToArrowType(row[1] as string),
    nullable: row[2] as boolean,
    ordinalPosition: (row[3] as number) - 1,
  }));

  let rowCount = 0;
  const sizeBytes = 0;
  try {
    const countResult = await conn.run(`SELECT COUNT(*) FROM "${msg.tableName}"`);
    const countRows = await countResult.getRows();
    rowCount = Number(countRows[0]?.[0] ?? 0);

    // Size estimation not available in all DuckDB versions; leave as 0
  } catch (countErr) {
    console.warn(
      `Failed to get row count for "${msg.tableName}":`,
      countErr instanceof Error ? countErr.message : String(countErr),
    );
  }

  port.postMessage({
    type: 'table_info',
    tableName: msg.tableName,
    columns,
    rowCount,
    sizeBytes,
  });
}

async function handleHealthCheck(): Promise<void> {
  const response: WorkerHealthResponse = {
    type: 'health_check_result',
    status: 'healthy',
    tables: 0,
    memoryUsedMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
    activeQueries: activeQueries.size,
  };

  try {
    const conn = getConnection();
    const result = await conn.run(`
      SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'main' AND table_name NOT LIKE '\\_\\_%' ESCAPE '\\'
    `);
    const rows = await result.getRows();
    response.tables = Number(rows[0]?.[0] ?? 0);
  } catch {
    response.status = 'degraded';
  }

  port.postMessage(response);
}

function handleHeartbeat(msg: HeartbeatRequest): void {
  const ack: HeartbeatAck = {
    type: 'heartbeat_ack',
    sentAt: msg.sentAt,
    status: activeQueries.size > 0 ? 'busy' : 'healthy',
    details: {
      activeQueries: activeQueries.size,
      memoryUsageMB: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
      uptime: Date.now() - startTime,
    },
  };
  port.postMessage(ack);
}

const MEMORY_LIMIT_RE = /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB)$/i;
const TEMP_DIR_RE = /^[^'";]+$/;

async function handleConfigure(msg: WorkerConfigUpdate): Promise<void> {
  const conn = getConnection();
  const { settings } = msg;
  if (settings.memory_limit) {
    if (!MEMORY_LIMIT_RE.test(settings.memory_limit.trim())) {
      port.postMessage({
        type: 'error',
        message: `Invalid memory_limit: ${settings.memory_limit}`,
      });
      return;
    }
    await conn.run(`SET memory_limit = '${settings.memory_limit.trim()}'`);
  }
  if (settings.threads) {
    if (!Number.isInteger(settings.threads) || settings.threads <= 0) {
      port.postMessage({ type: 'error', message: `Invalid threads: ${settings.threads}` });
      return;
    }
    await conn.run(`SET threads = ${settings.threads}`);
  }
  if (settings.temp_directory) {
    if (!TEMP_DIR_RE.test(settings.temp_directory)) {
      port.postMessage({
        type: 'error',
        message: `Invalid temp_directory: ${settings.temp_directory}`,
      });
      return;
    }
    await conn.run(`SET temp_directory = '${settings.temp_directory}'`);
  }
}

async function handleShutdown(): Promise<void> {
  for (const [, state] of activeQueries) {
    state.cancelled = true;
  }
  await closeDuckDB();
  port.postMessage({ type: 'shutdown-complete', worker: 'duckdb' });
}

// ============================================================
// Ingestion Handlers
// ============================================================

/** Escape a string value for use in single-quoted SQL literals. */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** Build CSV/TSV read_csv() parameters. */
function buildCsvParams(
  format: 'csv' | 'tsv',
  options: IngestFileOptions,
  encoding?: 'utf-8' | 'latin-1',
): string[] {
  const delimiter = format === 'tsv' ? '\\t' : (options.delimiter ?? ',');
  const params: string[] = [`delim='${escapeSqlString(delimiter)}'`];
  if (options.header !== undefined) {
    params.push(`header=${options.header ? 'true' : 'false'}`);
  }
  if (options.sampleSize !== undefined) {
    params.push(`sample_size=${options.sampleSize}`);
  }
  if (options.ignoreErrors !== undefined) {
    params.push(`ignore_errors=${options.ignoreErrors ? 'true' : 'false'}`);
  }
  const enc = encoding ?? options.encoding;
  if (enc === 'latin-1') {
    params.push(`encoding='latin-1'`);
  }
  return params;
}

/** Build JSON/JSONL read_json() parameters. */
function buildJsonParams(options: IngestFileOptions): string[] {
  const params: string[] = [];
  const fmt = options.jsonFormat ?? 'auto';
  params.push(`format='${fmt}'`);
  if (options.maxDepth !== undefined) {
    params.push(`maximum_depth=${options.maxDepth}`);
  }
  if (options.ignoreErrors !== undefined) {
    params.push(`ignore_errors=${options.ignoreErrors ? 'true' : 'false'}`);
  }
  return params;
}

/**
 * Build the format-specific DuckDB read function call for a given file.
 *
 * @param filePath - Absolute path to the file (already SQL-escaped).
 * @param format - Detected or declared file format.
 * @param options - User/auto-detected parse options.
 * @param encoding - Override encoding (for UTF-8 fallback retry).
 * @returns SQL fragment like `read_csv('/path/to/file.csv', delim=',', header=true, ...)`
 */
function buildReadFunction(
  filePath: string,
  format: DataSourceFormat,
  options: IngestFileOptions,
  encoding?: 'utf-8' | 'latin-1',
): string {
  const escaped = escapeSqlString(filePath);

  switch (format) {
    case 'csv':
    case 'tsv':
      return `read_csv('${escaped}', ${buildCsvParams(format, options, encoding).join(', ')})`;
    case 'parquet':
      return `read_parquet('${escaped}')`;
    case 'json':
    case 'jsonl':
      return `read_json('${escaped}', ${buildJsonParams(options).join(', ')})`;
    case 'xlsx': {
      const sheetParam =
        options.sheet !== undefined ? `, sheet='${escapeSqlString(String(options.sheet))}'` : '';
      return `read_xlsx('${escaped}'${sheetParam})`;
    }
    case 'arrow_ipc':
      return `read_arrow('${escaped}')`;
  }
}

/**
 * Query information_schema.columns for a table/view and return column metadata.
 */
async function getColumnInfo(
  tableName: string,
): Promise<{ name: string; type: string; nullable: boolean }[]> {
  const conn = getConnection();
  const escapedName = escapeSqlString(tableName);
  const result = await conn.run(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'main' AND table_name = '${escapedName}'
    ORDER BY ordinal_position
  `);
  const rows = await result.getRows();
  return rows.map((row: unknown[]) => ({
    name: row[0] as string,
    type: row[1] as string,
    nullable: (row[2] as string) === 'YES',
  }));
}

/** Get the row count for a table or view. */
async function getRowCount(tableName: string): Promise<number> {
  const conn = getConnection();
  const result = await conn.run(`SELECT COUNT(*) FROM "${tableName}"`);
  const rows = await result.getRows();
  return Number(rows[0]?.[0] ?? 0);
}

async function handleIngestFile(req: WorkerIngestFileRequest): Promise<void> {
  const { jobId, filePath, format, tableName, options } = req;
  const startMs = Date.now();

  try {
    const conn = getConnection();
    const readFn = buildReadFunction(filePath, format, options);
    const escapedTable = tableName.replace(/"/g, '""');
    const sql = `CREATE OR REPLACE TABLE "${escapedTable}" AS SELECT * FROM ${readFn}`;

    try {
      await conn.run(sql);
    } catch (error) {
      // RQ-6: Two-pass encoding for CSV/TSV — retry with latin-1 on UTF-8 errors
      const errMsg = error instanceof Error ? error.message : String(error);
      if ((format === 'csv' || format === 'tsv') && errMsg.includes('not valid UTF8')) {
        const readFnLatin1 = buildReadFunction(filePath, format, options, 'latin-1');
        const sqlRetry = `CREATE OR REPLACE TABLE "${escapedTable}" AS SELECT * FROM ${readFnLatin1}`;
        await conn.run(sqlRetry);
      } else {
        throw error;
      }
    }

    // T045: Rename DuckDB-generated column names to col_1, col_2, ... for headerless CSV/TSV
    if (options.header === false && (format === 'csv' || format === 'tsv')) {
      const colResult = await conn.run(`
        SELECT column_name, ordinal_position
        FROM information_schema.columns
        WHERE table_schema = 'main' AND table_name = '${escapeSqlString(tableName)}'
        ORDER BY ordinal_position
      `);
      const colRows = await colResult.getRows();
      for (const row of colRows) {
        const oldName = row[0] as string;
        const ordinal = row[1] as number;
        const newName = `col_${ordinal}`;
        if (oldName !== newName) {
          await conn.run(
            `ALTER TABLE "${escapedTable}" RENAME COLUMN "${oldName.replace(/"/g, '""')}" TO "${newName}"`,
          );
        }
      }
    }

    const columns = await getColumnInfo(tableName);
    const rowCount = await getRowCount(tableName);

    port.postMessage({
      type: 'ingest_file_complete',
      jobId,
      tableName,
      rowCount,
      columnCount: columns.length,
      columns,
      durationMs: Date.now() - startMs,
      skippedRows: 0,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', message: `Ingestion failed for job ${jobId}: ${errMsg}` });
  }
}

async function handlePreviewFile(req: WorkerPreviewFileRequest): Promise<void> {
  const { filePath, format, viewName, options } = req;

  try {
    const conn = getConnection();
    const readFn = buildReadFunction(filePath, format, options);
    const escapedView = viewName.replace(/"/g, '""');
    const sql = `CREATE OR REPLACE VIEW "${escapedView}" AS SELECT * FROM ${readFn}`;

    try {
      await conn.run(sql);
    } catch (error) {
      // RQ-6: Two-pass encoding for CSV/TSV
      const errMsg = error instanceof Error ? error.message : String(error);
      if ((format === 'csv' || format === 'tsv') && errMsg.includes('not valid UTF8')) {
        const readFnLatin1 = buildReadFunction(filePath, format, options, 'latin-1');
        const sqlRetry = `CREATE OR REPLACE VIEW "${escapedView}" AS SELECT * FROM ${readFnLatin1}`;
        await conn.run(sqlRetry);
      } else {
        throw error;
      }
    }

    const columns = await getColumnInfo(viewName);
    const estimatedRowCount = await getRowCount(viewName);

    port.postMessage({
      type: 'preview_file_complete',
      viewName,
      columns,
      estimatedRowCount,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', message: `Preview failed: ${errMsg}` });
  }
}

async function handleSniffCsv(req: WorkerSniffCsvRequest): Promise<void> {
  const { filePath } = req;

  try {
    const conn = getConnection();
    const escaped = escapeSqlString(filePath);
    const result = await conn.run(`SELECT * FROM sniff_csv('${escaped}')`);
    const rows = await result.getRows();

    if (rows.length === 0) {
      port.postMessage({
        type: 'error',
        message: `sniff_csv returned no results for: ${filePath}`,
      });
      return;
    }

    const row = rows[0] as unknown[];
    // sniff_csv returns columns: Delimiter, Quote, Escape, NewLineDelimiter, SkipRows,
    // HasHeader, Columns, DateFormat, TimestampFormat, UserArguments, Prompt
    const delimiter = (row[0] as string | null) ?? ',';
    const quoteChar = (row[1] as string | null) ?? '"';
    const escapeChar = (row[2] as string | null) ?? '"';
    const newlineDelimiter = (row[3] as string | null) ?? '\\n';
    const hasHeader = Boolean(row[5]);

    // Columns is a complex nested type — parse it as an array of {name, type}
    const rawColumns = row[6];
    let columns: { name: string; type: string }[] = [];
    if (Array.isArray(rawColumns)) {
      columns = rawColumns.map((col: unknown) => {
        if (col && typeof col === 'object' && 'name' in col && 'type' in col) {
          return {
            name: (col as { name: string }).name,
            type: (col as { type: string }).type,
          };
        }
        return { name: col as string, type: 'VARCHAR' };
      });
    }

    const dateFormat = row[7] !== null && row[7] !== undefined ? (row[7] as string) : undefined;
    const timestampFormat =
      row[8] !== null && row[8] !== undefined ? (row[8] as string) : undefined;

    port.postMessage({
      type: 'sniff_csv_complete',
      filePath,
      delimiter,
      quoteChar,
      escapeChar,
      hasHeader,
      newlineDelimiter,
      columns,
      ...(dateFormat !== undefined ? { dateFormat } : {}),
      ...(timestampFormat !== undefined ? { timestampFormat } : {}),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', message: `CSV sniff failed: ${errMsg}` });
  }
}

/** Column statistics shape returned by compute_stats handler. */
interface ColumnStatEntry {
  columnName: string;
  columnType: string;
  rowCount: number;
  nullCount: number;
  nullPercentage: number;
  distinctCount: number;
  min?: string;
  max?: string;
  mean?: number;
  median?: number;
  stddev?: number;
  q25?: number;
  q75?: number;
  topValues?: { value: string; count: number }[];
}

/** Convert a DuckDB SUMMARIZE row value to an optional string. */
function toOptionalString(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  return typeof val === 'string' ? val : `${val as number}`;
}

/** Convert a DuckDB SUMMARIZE row value to an optional number (NaN-safe). */
function toOptionalNumber(val: unknown): number | undefined {
  if (val === null || val === undefined) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

/** Parse a single SUMMARIZE row into a ColumnStatEntry. */
function parseSummarizeRow(row: unknown[], totalRowCount: number): ColumnStatEntry {
  const nullPct = Number(row[11] ?? 0);
  const minVal = toOptionalString(row[2]);
  const maxVal = toOptionalString(row[3]);
  const meanVal = toOptionalNumber(row[5]);
  const stdVal = toOptionalNumber(row[6]);
  const q25Val = toOptionalNumber(row[7]);
  const medianVal = toOptionalNumber(row[8]);
  const q75Val = toOptionalNumber(row[9]);

  const entry: ColumnStatEntry = {
    columnName: String(row[0]),
    columnType: String(row[1]),
    rowCount: Number(row[10] ?? 0),
    nullCount: Math.round((nullPct / 100) * totalRowCount),
    nullPercentage: nullPct,
    distinctCount: Number(row[4] ?? 0),
  };
  if (minVal !== undefined) entry.min = minVal;
  if (maxVal !== undefined) entry.max = maxVal;
  if (meanVal !== undefined) entry.mean = meanVal;
  if (medianVal !== undefined) entry.median = medianVal;
  if (stdVal !== undefined) entry.stddev = stdVal;
  if (q25Val !== undefined) entry.q25 = q25Val;
  if (q75Val !== undefined) entry.q75 = q75Val;
  return entry;
}

/** Compute top-N frequent values for a categorical column. Returns undefined on failure. */
async function computeTopValues(
  escapedTable: string,
  colName: string,
  topN: number,
): Promise<{ value: string; count: number }[] | undefined> {
  try {
    const conn = getConnection();
    const escapedCol = colName.replace(/"/g, '""');
    const topResult = await conn.run(
      `SELECT "${escapedCol}" AS value, COUNT(*) AS cnt FROM "${escapedTable}" GROUP BY 1 ORDER BY 2 DESC LIMIT ${topN}`,
    );
    const topRows = await topResult.getRows();
    return topRows.map((r: unknown[]) => ({
      value: (r[0] as string | null) ?? '',
      count: Number(r[1] ?? 0),
    }));
  } catch {
    // Best effort — skip top values on error
    return undefined;
  }
}

async function handleComputeStats(req: WorkerComputeStatsRequest): Promise<void> {
  const { tableName, columns: requestedColumns, topN: requestedTopN } = req;
  const startMs = Date.now();
  const topN = requestedTopN ?? 10;

  try {
    const conn = getConnection();
    const escapedTable = tableName.replace(/"/g, '""');

    const summaryResult = await conn.run(`SUMMARIZE SELECT * FROM "${escapedTable}"`);
    const summaryRows = await summaryResult.getRows();
    const totalRowCount = await getRowCount(tableName);

    const columnStats: ColumnStatEntry[] = [];

    for (const row of summaryRows) {
      const colName = String(row[0]);
      const colType = String(row[1]);

      if (requestedColumns && requestedColumns.length > 0 && !requestedColumns.includes(colName)) {
        continue;
      }

      const stat = parseSummarizeRow(row, totalRowCount);

      // For categorical columns (VARCHAR with low cardinality), compute top-N values
      if (colType.toUpperCase() === 'VARCHAR' && stat.distinctCount < topN * 10) {
        const topValues = await computeTopValues(escapedTable, colName, topN);
        if (topValues) {
          stat.topValues = topValues;
        }
      }

      columnStats.push(stat);
    }

    port.postMessage({
      type: 'compute_stats_complete',
      tableName,
      columns: columnStats,
      durationMs: Date.now() - startMs,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', message: `Statistics computation failed: ${errMsg}` });
  }
}

async function handleDropTable(req: WorkerDropTableRequest): Promise<void> {
  const { tableName, isView } = req;

  try {
    const conn = getConnection();
    const escapedTable = tableName.replace(/"/g, '""');
    const sql = isView
      ? `DROP VIEW IF EXISTS "${escapedTable}"`
      : `DROP TABLE IF EXISTS "${escapedTable}"`;
    await conn.run(sql);

    port.postMessage({
      type: 'drop_table_complete',
      tableName,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', message: `Drop failed for "${tableName}": ${errMsg}` });
  }
}

async function handleInstallExtension(req: WorkerInstallExtensionRequest): Promise<void> {
  const { extensionName, source } = req;

  try {
    const conn = getConnection();
    const installSql =
      source === 'community'
        ? `INSTALL ${extensionName} FROM community`
        : `INSTALL ${extensionName}`;
    await conn.run(installSql);
    await conn.run(`LOAD ${extensionName}`);

    port.postMessage({
      type: 'install_extension_complete',
      extensionName,
      loaded: true,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.warn(`Extension install failed for "${extensionName}":`, errMsg);
    port.postMessage({
      type: 'install_extension_complete',
      extensionName,
      loaded: false,
    });
  }
}

function sendDataPlaneMessage(message: Record<string, unknown>): void {
  if (dataPort) {
    dataPort.postMessage(message);
  } else {
    console.warn('Data port not established, cannot send:', message['type']);
    port.postMessage({
      type: 'error',
      message: `Data port not established; cannot send ${String(message['type'])} for query ${String(message['queryId'])}`,
    });
  }
}

function sendDataPlaneTransfer(envelope: Record<string, unknown>, buffer: ArrayBuffer): void {
  if (dataPort) {
    dataPort.postMessage({ ...envelope, buffer }, [buffer]);
  } else {
    console.warn('Data port not established, cannot transfer:', envelope['type']);
    port.postMessage({
      type: 'error',
      message: `Data port not established; cannot transfer ${String(envelope['type'])} for query ${String(envelope['queryId'])}`,
    });
  }
}

/**
 * Local error classification for the worker bundle.
 *
 * Duplicates the logic in {@link classifyDuckDBError} from `src/shared/errors.ts`.
 * A local copy exists because the worker is built as an isolated Vite bundle and
 * does not share modules with the main process at runtime.
 */
function classifyErrorCode(message: string): string {
  const msg = message.toLowerCase();
  if (msg.includes('syntax error') || msg.includes('parser error')) return 'E1001';
  if (msg.includes('does not exist') && msg.includes('table')) return 'E1004';
  if (msg.includes('does not exist') && msg.includes('column')) return 'E1005';
  if (msg.includes('type mismatch')) return 'E1006';
  if (msg.includes('out of memory') || msg.includes('memory limit')) return 'E1007';
  return 'E1001';
}

function mapDuckDbToArrowType(duckdbType: string): string {
  const typeMap: Record<string, string> = {
    BOOLEAN: 'Bool',
    TINYINT: 'Int8',
    SMALLINT: 'Int16',
    INTEGER: 'Int32',
    BIGINT: 'Int64',
    UTINYINT: 'Uint8',
    USMALLINT: 'Uint16',
    UINTEGER: 'Uint32',
    UBIGINT: 'Uint64',
    FLOAT: 'Float32',
    DOUBLE: 'Float64',
    VARCHAR: 'Utf8',
    BLOB: 'Binary',
    DATE: 'Date32',
    TIME: 'Time64(us)',
    TIMESTAMP: 'Timestamp(us, UTC)',
    'TIMESTAMP WITH TIME ZONE': 'Timestamp(us, UTC)',
    INTERVAL: 'Duration(us)',
    HUGEINT: 'Decimal128',
  };
  return typeMap[duckdbType.toUpperCase()] ?? 'Utf8';
}

// T050: Create sample tables for development and testing
async function createSampleData(): Promise<void> {
  const conn = getConnection();

  // Check if sample tables already exist
  const checkResult = await conn.run(`
    SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = 'main' AND table_name = 'products'
  `);
  const checkRows = await checkResult.getRows();
  if (Number(checkRows[0]?.[0] ?? 0) > 0) return; // Already seeded

  // Products table (500 rows)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS products AS
    SELECT
      row_number() OVER () AS id,
      'Product ' || (row_number() OVER ()) AS name,
      CASE (random() * 4)::INT
        WHEN 0 THEN 'Electronics'
        WHEN 1 THEN 'Clothing'
        WHEN 2 THEN 'Food'
        WHEN 3 THEN 'Books'
        ELSE 'Other'
      END AS category,
      round(random() * 1000 + 1, 2)::DOUBLE AS price,
      (random() * 1000)::INT AS stock
    FROM range(500)
  `);

  // Sales table (10000 rows for faster dev startup; would be 1M in production test)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS sales AS
    SELECT
      row_number() OVER () AS id,
      (random() * 499 + 1)::INT AS product_id,
      CASE (random() * 5)::INT
        WHEN 0 THEN 'North'
        WHEN 1 THEN 'South'
        WHEN 2 THEN 'East'
        WHEN 3 THEN 'West'
        ELSE 'Central'
      END AS region,
      round(random() * 500 + 1, 2)::DOUBLE AS amount,
      (random() * 10 + 1)::INT AS quantity,
      DATE '2024-01-01' + INTERVAL ((random() * 730)::INT) DAY AS sale_date,
      CASE (random() * 2)::INT
        WHEN 0 THEN 'online'
        WHEN 1 THEN 'store'
        ELSE 'wholesale'
      END AS channel
    FROM range(10000)
  `);
}

// Initialize DuckDB on Worker startup
async function init(): Promise<void> {
  const config = workerData as DuckDBConfig;
  startTime = Date.now();
  await initDuckDB(config);
  const ok = await runIntegrityCheck();

  // Seed sample data for development
  try {
    await createSampleData();
  } catch (err) {
    console.error('Failed to create sample data:', err);
  }

  port.postMessage({
    type: 'ready',
    worker: 'duckdb',
    metadata: { extensionsLoaded: config.extensions, integrityOk: ok },
  });
}

init().catch((err: unknown) => {
  port.postMessage({
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
  });
});
