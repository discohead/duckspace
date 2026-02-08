import type { DuckDBValue } from '@duckdb/node-api';
import { PortSetupMessageSchema, WorkerInboundMessageSchema } from '@shared/schemas/worker-schemas';
import type {
  HeartbeatAck,
  HeartbeatRequest,
  WorkerCancelRequest,
  WorkerConfigUpdate,
  WorkerGetTableInfoRequest,
  WorkerHealthResponse,
  WorkerQueryRequest,
} from '@shared/types';
import { type MessagePort, parentPort, workerData } from 'worker_threads';
import {
  closeDuckDB,
  type DuckDBConfig,
  getConnection,
  initDuckDB,
  runIntegrityCheck,
} from './duckdb-connection';

if (!parentPort) {
  throw new Error('duckdb-worker must run as a Worker Thread');
}
const port = parentPort;

let dataPort: MessagePort | null = null;
const activeQueries = new Map<string, { cancelled: boolean }>();
let startTime = Date.now();

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
  return message.replace(/SELECT \* FROM to_arrow_ipc\(\(/, '').replace(/\)\)\s*$/, '');
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
      case 'execute_query':
        await handleExecuteQuery(validated);
        break;
      case 'cancel_query':
        handleCancelQuery(validated);
        break;
      case 'get_table_info':
        await handleGetTableInfo(validated);
        break;
      case 'list_tables':
        await handleListTables();
        break;
      case 'health_check':
        await handleHealthCheck();
        break;
      case 'heartbeat':
        handleHeartbeat(validated);
        break;
      case 'configure':
        await handleConfigure(validated);
        break;
      case 'shutdown':
        await handleShutdown();
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
      `INSERT INTO _query_history (query_id, sql, execution_time_ms, row_count, status)
       VALUES ('${queryId}', '${escapedSql}', ${executionTimeMs}, 0, 'success')`,
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

    const wrappedSql = `SELECT * FROM to_arrow_ipc((${sql}))`;
    const result =
      params && params.length > 0
        ? await conn.run(wrappedSql, params as DuckDBValue[])
        : await conn.run(wrappedSql);
    const rows = await result.getRows();

    if (queryState?.cancelled) {
      sendDataPlaneMessage({
        type: 'arrow-end',
        queryId,
        totalBatches: 0,
        totalRows: 0,
        totalBytes: 0,
        durationMs: Date.now() - startMs,
      });
      return;
    }

    // DuckDB's to_arrow_ipc() returns rows of (chunk BLOB, done BOOLEAN).
    // Each row's first column is a DuckDBBlobValue with a .bytes: Uint8Array
    // property — NOT a raw Uint8Array. Concatenate all chunks into one buffer.
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (const row of rows) {
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
        {
          type: 'arrow-batch',
          queryId,
          index: 0,
          totalBatches: 1,
          rowCount: 0,
          byteSize: buffer.byteLength,
        },
        buffer,
      );

      sendDataPlaneMessage({
        type: 'arrow-end',
        queryId,
        totalBatches: 1,
        totalRows: 0,
        totalBytes: buffer.byteLength,
        durationMs: Date.now() - startMs,
      });
    } else {
      sendDataPlaneMessage({
        type: 'arrow-end',
        queryId,
        totalBatches: 0,
        totalRows: 0,
        totalBytes: 0,
        durationMs: Date.now() - startMs,
      });
    }

    // Record in query history (best effort)
    const executionTimeMs = Date.now() - startMs;
    try {
      const escapedSql = sql.replace(/'/g, "''");
      await conn.run(
        `INSERT INTO _query_history (query_id, sql, execution_time_ms, row_count, status)
         VALUES ('${queryId}', '${escapedSql}', ${executionTimeMs}, 0, 'success')`,
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
        `INSERT INTO _query_history (query_id, sql, execution_time_ms, row_count, status, error_message)
         VALUES ('${queryId}', '${escapedSql}', ${errorExecutionTimeMs}, 0, 'error', '${escapedErr}')`,
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
    WHERE table_schema = 'main' AND table_name NOT LIKE '__%'
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
      WHERE table_schema = 'main' AND table_name NOT LIKE '__%'
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
