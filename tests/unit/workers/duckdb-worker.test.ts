import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock parentPort and workerData (must be before import)
//
// These live at module scope so vi.mock factories can close over them.
// vi.clearAllMocks() clears call history but preserves mock implementations
// since the mocks are re-created by the factory on each fresh import.
// --------------------------------------------------------------------------
const mockParentPort = {
  on: vi.fn(),
  postMessage: vi.fn(),
};

vi.mock('worker_threads', () => ({
  parentPort: mockParentPort,
  workerData: {
    dbPath: '/test/db.duckdb',
    memoryLimit: '256MB',
    threads: 2,
    tempDirectory: '/tmp',
    extensions: ['parquet'],
  },
}));

// --------------------------------------------------------------------------
// Mock duckdb-connection
// --------------------------------------------------------------------------
const mockInitDuckDb = vi.fn().mockResolvedValue(undefined);
const mockGetConnection = vi.fn();
const mockRunIntegrityCheck = vi.fn().mockResolvedValue(true);
const mockCloseDuckDb = vi.fn().mockResolvedValue(undefined);

vi.mock('@workers/duckdb-connection', () => ({
  initDuckDB: mockInitDuckDb,
  getConnection: mockGetConnection,
  runIntegrityCheck: mockRunIntegrityCheck,
  closeDuckDB: mockCloseDuckDb,
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Captures the message handler registered on parentPort.on('message', ...) */
function getMessageHandler(): (msg: any) => Promise<void> {
  const onCall = mockParentPort.on.mock.calls.find((c: any[]) => c[0] === 'message');
  if (!onCall) throw new Error('No message handler registered on parentPort');
  return onCall[1];
}

function createMockRun(rows: any[][] = []) {
  return vi.fn().mockResolvedValue({
    getRows: vi.fn().mockResolvedValue(rows),
  });
}

/** Wait for init() to complete by flushing microtasks */
async function flushInit() {
  await vi.waitFor(
    () => {
      const readyCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'ready' || c[0]?.type === 'error',
      );
      if (!readyCall) throw new Error('init not completed');
    },
    { timeout: 2000 },
  );
}

/**
 * Load the worker module fresh (after vi.resetModules) and wait for init.
 * Sets up a default connection mock that returns empty rows for all queries.
 */
async function loadWorker() {
  // Default connection: return empty rows for everything
  const run = createMockRun([]);
  mockGetConnection.mockReturnValue({ run });

  await import('@workers/duckdb-worker');
  await flushInit();
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('duckdb-worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset mock implementations
    mockInitDuckDb.mockResolvedValue(undefined);
    mockRunIntegrityCheck.mockResolvedValue(true);
    mockCloseDuckDb.mockResolvedValue(undefined);
  });

  // ========================================================================
  // Module initialization (init function)
  // ========================================================================

  describe('initialization', () => {
    it('calls initDuckDB with workerData config on load', async () => {
      await loadWorker();

      expect(mockInitDuckDb).toHaveBeenCalledWith({
        dbPath: '/test/db.duckdb',
        memoryLimit: '256MB',
        threads: 2,
        tempDirectory: '/tmp',
        extensions: ['parquet'],
      });
    });

    it('runs integrity check after init', async () => {
      await loadWorker();

      expect(mockRunIntegrityCheck).toHaveBeenCalledOnce();
    });

    it('posts "ready" message after successful init', async () => {
      await loadWorker();

      const readyCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'ready',
      );
      expect(readyCall).toBeDefined();
      expect(readyCall?.[0]).toEqual(
        expect.objectContaining({
          type: 'ready',
          worker: 'duckdb',
          metadata: expect.objectContaining({
            extensionsLoaded: ['parquet'],
            integrityOk: true,
          }),
        }),
      );
    });

    it('posts "ready" with integrityOk=false when check fails', async () => {
      mockRunIntegrityCheck.mockResolvedValueOnce(false);

      await loadWorker();

      const readyCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'ready',
      );
      expect(readyCall?.[0].metadata.integrityOk).toBe(false);
    });

    it('posts error message if initDuckDB fails', async () => {
      mockInitDuckDb.mockRejectedValueOnce(new Error('init failure'));

      // Default connection is still needed for the mock module
      const run = createMockRun([]);
      mockGetConnection.mockReturnValue({ run });

      await import('@workers/duckdb-worker');
      await vi.waitFor(
        () => {
          const errorCall = mockParentPort.postMessage.mock.calls.find(
            (c: any[]) => c[0]?.type === 'error',
          );
          if (!errorCall) throw new Error('error not posted');
        },
        { timeout: 2000 },
      );

      const errorCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'error',
      );
      expect(errorCall?.[0]).toEqual({
        type: 'error',
        message: 'init failure',
      });
    });

    it('registers message handler on parentPort', async () => {
      await loadWorker();

      expect(mockParentPort.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  // ========================================================================
  // Port setup
  // ========================================================================

  describe('port message', () => {
    it('stores data port and posts port-ready', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      expect(mockParentPort.postMessage).toHaveBeenCalledWith({
        type: 'port-ready',
        channel: 'duckdb-data',
      });
    });
  });

  // ========================================================================
  // execute_query
  // ========================================================================

  describe('execute_query', () => {
    it('wraps SQL with to_arrow_ipc and sends arrow-batch + arrow-end', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      // Set up data port
      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      // Set up connection that returns IPC buffer as DuckDBBlobValue
      const blobValue = { bytes: new Uint8Array([1, 2, 3, 4]) };
      const run = vi
        .fn()
        // to_arrow_ipc query — returns DuckDBBlobValue with .bytes property
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[blobValue, false]]),
        })
        // query history insert (best effort)
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([]),
        });
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q1', sql: 'SELECT 1' });

      // Check SQL wrapping
      expect(run).toHaveBeenCalledWith('SELECT * FROM to_arrow_ipc((SELECT 1))');

      // Check arrow-batch was sent on data port
      const batchCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-batch',
      );
      expect(batchCall).toBeDefined();
      expect(batchCall?.[0].queryId).toBe('q1');
      expect(batchCall?.[0].byteSize).toBe(4);

      // Check arrow-end was sent on data port
      const endCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-end',
      );
      expect(endCall).toBeDefined();
      expect(endCall?.[0].queryId).toBe('q1');
      expect(endCall?.[0].totalBatches).toBe(1);
    });

    it('sends arrow-end with zero totals for empty results', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const run = createMockRun([]);
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q2', sql: 'SELECT 1 WHERE false' });

      const endCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-end',
      );
      expect(endCall).toBeDefined();
      expect(endCall?.[0].totalBatches).toBe(0);
      expect(endCall?.[0].totalRows).toBe(0);
      expect(endCall?.[0].totalBytes).toBe(0);
    });

    it('sends arrow-end when rows exist but first row is null', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const run = createMockRun([[null]]);
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q3', sql: 'SELECT NULL' });

      const endCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-end',
      );
      expect(endCall).toBeDefined();
      expect(endCall?.[0].totalBatches).toBe(0);
    });

    it('posts query_history_record on success', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const run = createMockRun([]);
      mockGetConnection.mockReturnValue({ run });

      // Clear postMessage calls from init
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'execute_query', queryId: 'q1', sql: 'SELECT 1' });

      const historyCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'query_history_record',
      );
      expect(historyCall).toBeDefined();
      expect(historyCall?.[0]).toEqual(
        expect.objectContaining({
          type: 'query_history_record',
          queryId: 'q1',
          sql: 'SELECT 1',
          status: 'success',
          rowCount: 0,
        }),
      );
    });

    it('sends arrow-error and error query_history_record on query failure', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const failRun = vi
        .fn()
        .mockRejectedValueOnce(new Error('syntax error in SQL'))
        // For query history insert (getConnection is called again)
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run: failRun });

      mockParentPort.postMessage.mockClear();

      await handler({ type: 'execute_query', queryId: 'q-err', sql: 'SELEC 1' });

      // arrow-error on data port
      const errorCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-error',
      );
      expect(errorCall).toBeDefined();
      expect(errorCall?.[0].queryId).toBe('q-err');
      expect(errorCall?.[0].code).toBe('E1001');
      expect(errorCall?.[0].message).toContain('syntax error');

      // Error query history record
      const historyCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'query_history_record',
      );
      expect(historyCall).toBeDefined();
      expect(historyCall?.[0].status).toBe('error');
      expect(historyCall?.[0].errorMessage).toContain('syntax error');
    });
  });

  // ========================================================================
  // cancel_query
  // ========================================================================

  describe('cancel_query', () => {
    it('marks an active query as cancelled', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      // Start a query that we can cancel mid-flight
      const slowRun = vi.fn().mockImplementation(async () => {
        // Cancel while query is "running"
        await handler({ type: 'cancel_query', queryId: 'q-cancel' });
        return { getRows: vi.fn().mockResolvedValue([[new Uint8Array([1, 2])]]) };
      });
      mockGetConnection.mockReturnValue({ run: slowRun });

      await handler({ type: 'execute_query', queryId: 'q-cancel', sql: 'SELECT slow()' });

      // Should send arrow-end with 0 batches (query was cancelled)
      const endCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-end',
      );
      expect(endCall).toBeDefined();
      expect(endCall?.[0].totalBatches).toBe(0);
    });
  });

  // ========================================================================
  // list_tables
  // ========================================================================

  describe('list_tables', () => {
    it('queries information_schema and posts table_list', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      // Mock for list_tables query
      const run = vi
        .fn()
        // information_schema.tables query
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([
            ['users', 'BASE TABLE'],
            ['orders', 'VIEW'],
          ]),
        })
        // column count for users
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[5]]),
        })
        // row count for users
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[100]]),
        })
        // column count for orders
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[3]]),
        })
        // row count for orders
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[50]]),
        });

      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'list_tables' });

      const tableListCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'table_list',
      );
      expect(tableListCall).toBeDefined();

      const { tables } = tableListCall?.[0];
      expect(tables).toHaveLength(2);

      expect(tables[0].name).toBe('users');
      expect(tables[0].type).toBe('table');
      expect(tables[0].columnCount).toBe(5);
      expect(tables[0].rowCount).toBe(100);
      expect(tables[0].schema).toBe('main');
      expect(tables[0].status).toBe('active');

      expect(tables[1].name).toBe('orders');
      expect(tables[1].type).toBe('view');
      expect(tables[1].columnCount).toBe(3);
      expect(tables[1].rowCount).toBe(50);
    });

    it('handles empty table list', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const run = createMockRun([]);
      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'list_tables' });

      const tableListCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'table_list',
      );
      expect(tableListCall).toBeDefined();
      expect(tableListCall?.[0].tables).toHaveLength(0);
    });
  });

  // ========================================================================
  // get_table_info
  // ========================================================================

  describe('get_table_info', () => {
    it('queries column info and posts table_info', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const run = vi
        .fn()
        // Column query
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([
            ['id', 'INTEGER', false, 1],
            ['name', 'VARCHAR', true, 2],
            ['created_at', 'TIMESTAMP', true, 3],
          ]),
        })
        // Row count
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[42]]),
        });

      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'get_table_info', tableName: 'users' });

      const infoCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'table_info',
      );
      expect(infoCall).toBeDefined();
      expect(infoCall?.[0].tableName).toBe('users');
      expect(infoCall?.[0].rowCount).toBe(42);
      expect(infoCall?.[0].columns).toHaveLength(3);

      // Verify column mapping
      expect(infoCall?.[0].columns[0]).toEqual({
        name: 'id',
        duckdbType: 'INTEGER',
        arrowType: 'Int32',
        nullable: false,
        ordinalPosition: 0,
      });
      expect(infoCall?.[0].columns[1]).toEqual({
        name: 'name',
        duckdbType: 'VARCHAR',
        arrowType: 'Utf8',
        nullable: true,
        ordinalPosition: 1,
      });
      expect(infoCall?.[0].columns[2]).toEqual({
        name: 'created_at',
        duckdbType: 'TIMESTAMP',
        arrowType: 'Timestamp(us, UTC)',
        nullable: true,
        ordinalPosition: 2,
      });
    });

    it('escapes table names with single quotes', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const run = vi
        .fn()
        .mockResolvedValueOnce({ getRows: vi.fn().mockResolvedValue([]) })
        .mockResolvedValueOnce({ getRows: vi.fn().mockResolvedValue([[0]]) });

      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'get_table_info', tableName: "table'name" });

      const firstSql = run.mock.calls[0]![0] as string;
      expect(firstSql).toContain("table''name");
    });
  });

  // ========================================================================
  // health_check
  // ========================================================================

  describe('health_check', () => {
    it('posts health_check_result with status and table count', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const run = createMockRun([[3]]);
      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'health_check' });

      const healthCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'health_check_result',
      );
      expect(healthCall).toBeDefined();
      expect(healthCall?.[0].status).toBe('healthy');
      expect(healthCall?.[0].tables).toBe(3);
      expect(healthCall?.[0].memoryUsedMB).toBeTypeOf('number');
      expect(healthCall?.[0].activeQueries).toBe(0);
    });

    it('returns degraded status when table count query fails', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      mockGetConnection.mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('disk error')),
      });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'health_check' });

      const healthCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'health_check_result',
      );
      expect(healthCall?.[0].status).toBe('degraded');
    });
  });

  // ========================================================================
  // heartbeat
  // ========================================================================

  describe('heartbeat', () => {
    it('posts heartbeat_ack with echoed sentAt and status', async () => {
      await loadWorker();
      const handler = getMessageHandler();
      mockParentPort.postMessage.mockClear();

      const sentAt = Date.now();
      await handler({ type: 'heartbeat', sentAt });

      const ackCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'heartbeat_ack',
      );
      expect(ackCall).toBeDefined();
      expect(ackCall?.[0].sentAt).toBe(sentAt);
      expect(ackCall?.[0].status).toBe('healthy');
      expect(ackCall?.[0].details).toBeDefined();
      expect(ackCall?.[0].details.activeQueries).toBe(0);
      expect(ackCall?.[0].details.memoryUsageMB).toBeTypeOf('number');
      expect(ackCall?.[0].details.uptime).toBeTypeOf('number');
    });
  });

  // ========================================================================
  // configure
  // ========================================================================

  describe('configure', () => {
    it('runs SET commands for provided settings', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const run = vi.fn().mockResolvedValue(undefined);
      mockGetConnection.mockReturnValue({ run });

      await handler({
        type: 'configure',
        settings: {
          memory_limit: '512MB',
          threads: 4,
          temp_directory: '/tmp/new',
        },
      });

      expect(run).toHaveBeenCalledWith("SET memory_limit = '512MB'");
      expect(run).toHaveBeenCalledWith('SET threads = 4');
      expect(run).toHaveBeenCalledWith("SET temp_directory = '/tmp/new'");
    });

    it('only runs SET for provided settings', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const run = vi.fn().mockResolvedValue(undefined);
      mockGetConnection.mockReturnValue({ run });

      await handler({
        type: 'configure',
        settings: { memory_limit: '1GB' },
      });

      expect(run).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledWith("SET memory_limit = '1GB'");
    });

    // C1: Input validation against SQL injection
    describe('input validation', () => {
      it('rejects memory_limit with SQL injection attempt', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });
        mockParentPort.postMessage.mockClear();

        await handler({
          type: 'configure',
          settings: { memory_limit: "1GB'; DROP TABLE users; --" },
        });

        expect(run).not.toHaveBeenCalled();
        const errorCall = mockParentPort.postMessage.mock.calls.find(
          (c: any[]) => c[0]?.type === 'error',
        );
        expect(errorCall).toBeDefined();
      });

      it('rejects threads with non-positive integer', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });
        mockParentPort.postMessage.mockClear();

        await handler({ type: 'configure', settings: { threads: -1 } });

        expect(run).not.toHaveBeenCalled();
      });

      it('rejects temp_directory with quotes or semicolons', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });
        mockParentPort.postMessage.mockClear();

        await handler({
          type: 'configure',
          settings: { temp_directory: "/tmp'; --" },
        });

        expect(run).not.toHaveBeenCalled();
      });

      it('accepts valid memory_limit like "4GB"', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });

        await handler({ type: 'configure', settings: { memory_limit: '4GB' } });

        expect(run).toHaveBeenCalledWith(expect.stringContaining('4GB'));
      });

      it('accepts valid threads like 4', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });

        await handler({ type: 'configure', settings: { threads: 4 } });

        expect(run).toHaveBeenCalledWith(expect.stringContaining('4'));
      });

      it('accepts valid temp_directory', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });

        await handler({ type: 'configure', settings: { temp_directory: '/tmp/datspace' } });

        expect(run).toHaveBeenCalledWith(expect.stringContaining('/tmp/datspace'));
      });

      it('applies valid settings and skips invalid ones', async () => {
        await loadWorker();
        const handler = getMessageHandler();

        const run = vi.fn().mockResolvedValue(undefined);
        mockGetConnection.mockReturnValue({ run });
        mockParentPort.postMessage.mockClear();

        // memory_limit is valid, temp_directory has SQL injection (passes Zod string check but fails regex)
        await handler({
          type: 'configure',
          settings: { memory_limit: '4GB', temp_directory: "/tmp'; DROP TABLE x; --" },
        });

        // memory_limit is valid and processed first, then temp_directory fails and returns
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith("SET memory_limit = '4GB'");
      });
    });
  });

  // ========================================================================
  // shutdown
  // ========================================================================

  describe('shutdown', () => {
    it('cancels active queries, closes DuckDB, and posts shutdown-complete', async () => {
      await loadWorker();
      const handler = getMessageHandler();
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'shutdown' });

      expect(mockCloseDuckDb).toHaveBeenCalledOnce();

      const shutdownCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'shutdown-complete',
      );
      expect(shutdownCall).toBeDefined();
      expect(shutdownCall?.[0]).toEqual({
        type: 'shutdown-complete',
        worker: 'duckdb',
      });
    });
  });

  // ========================================================================
  // C8: sendDataPlaneMessage when dataPort is null
  // ========================================================================

  describe('sendDataPlaneMessage when dataPort is null', () => {
    it('posts error to control plane when dataPort is null during query', async () => {
      await loadWorker();
      const handler = getMessageHandler();
      // Do NOT set up data port — leave dataPort null
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[new Uint8Array([1, 2, 3])]]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'execute_query', queryId: 'q-no-port', sql: 'SELECT 1' });

      const errorCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'error' && c[0]?.message?.includes('Data port'),
      );
      expect(errorCall).toBeDefined();
    });

    it('posts error when dataPort is null during arrow-end send', async () => {
      await loadWorker();
      const handler = getMessageHandler();
      // Do NOT set up data port
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'execute_query', queryId: 'q-no-port-end', sql: 'SELECT 1' });

      const errorCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'error' && c[0]?.message?.includes('Data port'),
      );
      expect(errorCall).toBeDefined();
    });

    it('posts error when dataPort is null during arrow-error send', async () => {
      await loadWorker();
      const handler = getMessageHandler();
      // Do NOT set up data port
      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error('test error'))
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'execute_query', queryId: 'q-no-port-err', sql: 'BAD SQL' });

      const errorCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'error' && c[0]?.message?.includes('Data port'),
      );
      expect(errorCall).toBeDefined();
    });
  });

  // ========================================================================
  // classifyErrorCode (tested via execute_query error paths)
  // ========================================================================

  describe('classifyErrorCode (via execute_query)', () => {
    async function setupAndGetErrorCode(errorMessage: string): Promise<string> {
      // Each test in this describe has beforeEach run already.
      // loadWorker sets up default connection + waits for init.
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const run = vi
        .fn()
        .mockRejectedValueOnce(new Error(errorMessage))
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q-classify', sql: 'BAD' });

      const errorCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-error',
      );
      expect(errorCall).toBeDefined();
      return errorCall?.[0].code;
    }

    it('classifies syntax errors as E1001', async () => {
      const code = await setupAndGetErrorCode('Parser Error: syntax error at or near');
      expect(code).toBe('E1001');
    });

    it('classifies parser errors as E1001', async () => {
      const code = await setupAndGetErrorCode('parser error: unexpected token');
      expect(code).toBe('E1001');
    });

    it('classifies table not found as E1004', async () => {
      const code = await setupAndGetErrorCode('Table "foo" does not exist');
      expect(code).toBe('E1004');
    });

    it('classifies column not found as E1005', async () => {
      const code = await setupAndGetErrorCode('Column "bar" does not exist');
      expect(code).toBe('E1005');
    });

    it('classifies type mismatch as E1006', async () => {
      const code = await setupAndGetErrorCode('Conversion Error: type mismatch');
      expect(code).toBe('E1006');
    });

    it('classifies out of memory as E1007', async () => {
      const code = await setupAndGetErrorCode('Out of Memory: could not allocate');
      expect(code).toBe('E1007');
    });

    it('classifies memory limit as E1007', async () => {
      const code = await setupAndGetErrorCode('memory limit reached');
      expect(code).toBe('E1007');
    });

    it('defaults unknown errors to E1001', async () => {
      const code = await setupAndGetErrorCode('some unknown error occurred');
      expect(code).toBe('E1001');
    });
  });

  // ========================================================================
  // mapDuckDBToArrowType (tested via get_table_info)
  // ========================================================================

  describe('mapDuckDBToArrowType (via get_table_info)', () => {
    async function getArrowTypeFor(duckdbType: string): Promise<string> {
      // Each test in this describe has beforeEach run already.
      await loadWorker();
      const handler = getMessageHandler();

      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([['col', duckdbType, true, 1]]),
        })
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[0]]),
        });

      mockGetConnection.mockReturnValue({ run });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'get_table_info', tableName: 'test_table' });

      const infoCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'table_info',
      );
      expect(infoCall).toBeDefined();
      return infoCall?.[0].columns[0].arrowType;
    }

    it('maps BOOLEAN to Bool', async () => {
      expect(await getArrowTypeFor('BOOLEAN')).toBe('Bool');
    });

    it('maps TINYINT to Int8', async () => {
      expect(await getArrowTypeFor('TINYINT')).toBe('Int8');
    });

    it('maps SMALLINT to Int16', async () => {
      expect(await getArrowTypeFor('SMALLINT')).toBe('Int16');
    });

    it('maps INTEGER to Int32', async () => {
      expect(await getArrowTypeFor('INTEGER')).toBe('Int32');
    });

    it('maps BIGINT to Int64', async () => {
      expect(await getArrowTypeFor('BIGINT')).toBe('Int64');
    });

    it('maps FLOAT to Float32', async () => {
      expect(await getArrowTypeFor('FLOAT')).toBe('Float32');
    });

    it('maps DOUBLE to Float64', async () => {
      expect(await getArrowTypeFor('DOUBLE')).toBe('Float64');
    });

    it('maps VARCHAR to Utf8', async () => {
      expect(await getArrowTypeFor('VARCHAR')).toBe('Utf8');
    });

    it('maps BLOB to Binary', async () => {
      expect(await getArrowTypeFor('BLOB')).toBe('Binary');
    });

    it('maps DATE to Date32', async () => {
      expect(await getArrowTypeFor('DATE')).toBe('Date32');
    });

    it('maps TIMESTAMP to Timestamp(us, UTC)', async () => {
      expect(await getArrowTypeFor('TIMESTAMP')).toBe('Timestamp(us, UTC)');
    });

    it('maps TIMESTAMP WITH TIME ZONE to Timestamp(us, UTC)', async () => {
      expect(await getArrowTypeFor('TIMESTAMP WITH TIME ZONE')).toBe('Timestamp(us, UTC)');
    });

    it('maps HUGEINT to Decimal128', async () => {
      expect(await getArrowTypeFor('HUGEINT')).toBe('Decimal128');
    });

    it('maps unknown types to Utf8 (default)', async () => {
      expect(await getArrowTypeFor('CUSTOM_TYPE')).toBe('Utf8');
    });

    it('handles case-insensitive types', async () => {
      expect(await getArrowTypeFor('boolean')).toBe('Bool');
    });
  });

  // ========================================================================
  // Error handling in message handler
  // ========================================================================

  describe('error handling', () => {
    it('posts error message when handler throws', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      // Use 'configure' because it calls getConnection() without try/catch,
      // so any throw propagates to the outer catch in the message handler.
      mockGetConnection.mockImplementation(() => {
        throw new Error('connection lost');
      });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'configure', settings: { memory_limit: '1GB' } });

      const errorCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'error',
      );
      expect(errorCall).toBeDefined();
      expect(errorCall?.[0].message).toBe('connection lost');
    });

    it('converts non-Error throws to string', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      mockGetConnection.mockImplementation(() => {
        throw 'string error';
      });
      mockParentPort.postMessage.mockClear();

      await handler({ type: 'configure', settings: { memory_limit: '1GB' } });

      const errorCall = mockParentPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'error',
      );
      expect(errorCall).toBeDefined();
      expect(errorCall?.[0].message).toBe('string error');
    });
  });
});
