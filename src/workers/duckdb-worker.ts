import { parentPort, workerData, type MessagePort } from 'worker_threads';
import {
  initDuckDB,
  getConnection,
  runIntegrityCheck,
  closeDuckDB,
  type DuckDBConfig,
} from './duckdb-connection';
import type {
  WorkerQueryRequest,
  WorkerCancelRequest,
  WorkerHealthResponse,
  HeartbeatAck,
} from '@shared/types';

if (!parentPort) {
  throw new Error('duckdb-worker must run as a Worker Thread');
}

let dataPort: MessagePort | null = null;
const activeQueries = new Map<string, { cancelled: boolean }>();
let startTime = Date.now();

// Handle all incoming messages - use loose typing since 'port' messages
// are setup messages not part of the WorkerMessage union
parentPort.on('message', async (msg: { type: string; [key: string]: unknown }) => {
  try {
    // Port setup message (not part of WorkerMessage union)
    if (msg.type === 'port' && msg.channel === 'duckdb-data') {
      dataPort = msg.port as MessagePort;
      parentPort!.postMessage({ type: 'port-ready', channel: 'duckdb-data' });
      return;
    }

    switch (msg.type) {
      case 'execute_query':
        await handleExecuteQuery(msg as unknown as WorkerQueryRequest);
        break;
      case 'cancel_query':
        handleCancelQuery(msg as unknown as WorkerCancelRequest);
        break;
      case 'get_table_info':
        await handleGetTableInfo(msg as { type: string; tableName: string });
        break;
      case 'list_tables':
        await handleListTables();
        break;
      case 'health_check':
        await handleHealthCheck();
        break;
      case 'heartbeat':
        handleHeartbeat(msg as { type: string; sentAt: number });
        break;
      case 'configure':
        await handleConfigure(msg as { type: string; settings: Record<string, string | number> });
        break;
      case 'shutdown':
        await handleShutdown();
        break;
    }
  } catch (error) {
    parentPort!.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

async function handleExecuteQuery(req: WorkerQueryRequest): Promise<void> {
  const { queryId, sql } = req;
  activeQueries.set(queryId, { cancelled: false });
  const startMs = Date.now();

  try {
    const conn = getConnection();
    const queryState = activeQueries.get(queryId);

    const wrappedSQL = `SELECT * FROM to_arrow_ipc((${sql}))`;
    const result = await conn.run(wrappedSQL);
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

    if (rows.length > 0 && rows[0][0]) {
      const ipcBuffer: Uint8Array = rows[0][0];
      // Copy to a new ArrayBuffer so we can transfer ownership
      const buffer = new ArrayBuffer(ipcBuffer.byteLength);
      new Uint8Array(buffer).set(ipcBuffer);

      sendDataPlaneTransfer({
        type: 'arrow-batch',
        queryId,
        index: 0,
        totalBatches: 1,
        rowCount: 0,
        byteSize: buffer.byteLength,
      }, buffer);

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
         VALUES ('${queryId}', '${escapedSql}', ${executionTimeMs}, 0, 'success')`
      );
    } catch { /* non-critical */ }

    // T067: Forward query history record to renderer via Main
    parentPort!.postMessage({
      type: 'query_history_record',
      queryId,
      sql,
      executionTimeMs,
      rowCount: 0,
      status: 'success',
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
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
         VALUES ('${queryId}', '${escapedSql}', ${errorExecutionTimeMs}, 0, 'error', '${escapedErr}')`
      );
    } catch { /* non-critical */ }

    // T067: Forward query history record to renderer via Main
    parentPort!.postMessage({
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
    let sizeBytes = 0;
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
    } catch { /* best effort */ }

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

  parentPort!.postMessage({ type: 'table_list', tables });
}

async function handleGetTableInfo(msg: { type: string; tableName: string }): Promise<void> {
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
    arrowType: mapDuckDBToArrowType(row[1] as string),
    nullable: row[2] as boolean,
    ordinalPosition: (row[3] as number) - 1,
  }));

  let rowCount = 0;
  let sizeBytes = 0;
  try {
    const countResult = await conn.run(`SELECT COUNT(*) FROM "${msg.tableName}"`);
    const countRows = await countResult.getRows();
    rowCount = Number(countRows[0]?.[0] ?? 0);

    // Size estimation not available in all DuckDB versions; leave as 0
  } catch { /* best effort */ }

  parentPort!.postMessage({
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

  parentPort!.postMessage(response);
}

function handleHeartbeat(msg: { type: string; sentAt: number }): void {
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
  parentPort!.postMessage(ack);
}

async function handleConfigure(msg: { type: string; settings: Record<string, string | number> }): Promise<void> {
  const conn = getConnection();
  const { settings } = msg;
  if (settings.memory_limit) await conn.run(`SET memory_limit = '${settings.memory_limit}'`);
  if (settings.threads) await conn.run(`SET threads = ${settings.threads}`);
  if (settings.temp_directory) await conn.run(`SET temp_directory = '${settings.temp_directory}'`);
}

async function handleShutdown(): Promise<void> {
  for (const [, state] of activeQueries) {
    state.cancelled = true;
  }
  await closeDuckDB();
  parentPort!.postMessage({ type: 'shutdown-complete', worker: 'duckdb' });
}

function sendDataPlaneMessage(message: Record<string, unknown>): void {
  if (dataPort) dataPort.postMessage(message);
}

function sendDataPlaneTransfer(envelope: Record<string, unknown>, buffer: ArrayBuffer): void {
  if (dataPort) dataPort.postMessage({ ...envelope, __transferredBuffers: [buffer] }, [buffer]);
}

function classifyErrorCode(message: string): string {
  const msg = message.toLowerCase();
  if (msg.includes('syntax error') || msg.includes('parser error')) return 'E1001';
  if (msg.includes('does not exist') && msg.includes('table')) return 'E1004';
  if (msg.includes('does not exist') && msg.includes('column')) return 'E1005';
  if (msg.includes('type mismatch')) return 'E1006';
  if (msg.includes('out of memory') || msg.includes('memory limit')) return 'E1007';
  return 'E1001';
}

function mapDuckDBToArrowType(duckdbType: string): string {
  const typeMap: Record<string, string> = {
    BOOLEAN: 'Bool', TINYINT: 'Int8', SMALLINT: 'Int16', INTEGER: 'Int32', BIGINT: 'Int64',
    UTINYINT: 'Uint8', USMALLINT: 'Uint16', UINTEGER: 'Uint32', UBIGINT: 'Uint64',
    FLOAT: 'Float32', DOUBLE: 'Float64', VARCHAR: 'Utf8', BLOB: 'Binary',
    DATE: 'Date32', TIME: 'Time64(us)', TIMESTAMP: 'Timestamp(us, UTC)',
    'TIMESTAMP WITH TIME ZONE': 'Timestamp(us, UTC)', INTERVAL: 'Duration(us)', HUGEINT: 'Decimal128',
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

  parentPort!.postMessage({
    type: 'ready',
    worker: 'duckdb',
    metadata: { extensionsLoaded: config.extensions, integrityOk: ok },
  });
}

init().catch((err) => {
  parentPort!.postMessage({
    type: 'error',
    message: err instanceof Error ? err.message : String(err),
  });
});
