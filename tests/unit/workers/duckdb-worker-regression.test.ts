import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock parentPort and workerData
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
    extensions: [],
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

async function loadWorker() {
  const run = createMockRun([]);
  mockGetConnection.mockReturnValue({ run });
  await import('@workers/duckdb-worker');
  await flushInit();
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe('duckdb-worker — Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockInitDuckDb.mockResolvedValue(undefined);
    mockRunIntegrityCheck.mockResolvedValue(true);
    mockCloseDuckDb.mockResolvedValue(undefined);
  });

  // C1: sendDataPlaneTransfer must include buffer property, not __transferredBuffers
  describe('sendDataPlaneTransfer uses buffer property (C1)', () => {
    it('arrow-batch message includes buffer property in posted data', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      // DuckDB to_arrow_ipc returns DuckDBBlobValue objects with .bytes property
      const blobValue = { bytes: new Uint8Array([1, 2, 3, 4]) };
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[blobValue, false]]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q1', sql: 'SELECT 1' });

      const batchCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-batch',
      );
      expect(batchCall).toBeDefined();
      // Must have buffer property
      expect(batchCall?.[0]).toHaveProperty('buffer');
      expect(batchCall?.[0].buffer).toBeInstanceOf(ArrayBuffer);
      expect(batchCall?.[0].buffer.byteLength).toBe(4);
      // Must NOT have __transferredBuffers
      expect(batchCall?.[0]).not.toHaveProperty('__transferredBuffers');
    });
  });

  // C4: DuckDBBlobValue.bytes extraction — to_arrow_ipc returns DuckDBBlobValue, not Uint8Array
  describe('DuckDBBlobValue blob extraction (C4)', () => {
    it('extracts .bytes from DuckDBBlobValue and concatenates multi-row chunks', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      // Simulate to_arrow_ipc returning 2 rows: schema chunk + data chunk
      // Each row is (chunk BLOB, done BOOLEAN) — column 0 is DuckDBBlobValue
      const schemaBlob = { bytes: new Uint8Array([0xaa, 0xbb]) };
      const dataBlob = { bytes: new Uint8Array([0xcc, 0xdd, 0xee]) };
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([
            [schemaBlob, false],
            [dataBlob, true],
          ]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q-blob', sql: 'SELECT 42' });

      const batchCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-batch',
      );
      expect(batchCall).toBeDefined();

      const buffer = batchCall?.[0].buffer as ArrayBuffer;
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      // Must contain concatenated bytes from both chunks (2 + 3 = 5 bytes)
      expect(buffer.byteLength).toBe(5);
      const view = new Uint8Array(buffer);
      expect(view).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]));

      // arrow-end should report correct total bytes
      const endCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-end',
      );
      expect(endCall).toBeDefined();
      expect(endCall?.[0].totalBytes).toBe(5);
    });

    it('sends arrow-end with zero bytes when rows have no blob values', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      // Rows with no .bytes property — should produce 0-byte result
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[null, true]]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });

      await handler({ type: 'execute_query', queryId: 'q-null', sql: 'SELECT 1' });

      const batchCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-batch',
      );
      // No arrow-batch should be sent for 0-byte result
      expect(batchCall).toBeUndefined();

      const endCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-end',
      );
      expect(endCall).toBeDefined();
      expect(endCall?.[0].totalBytes).toBe(0);
      expect(endCall?.[0].totalBatches).toBe(0);
    });
  });

  // C3: handleExecuteQuery must pass params to conn.run
  describe('handleExecuteQuery passes params (C3)', () => {
    it('passes params to conn.run when provided', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });

      await handler({
        type: 'execute_query',
        queryId: 'q-params',
        sql: 'SELECT $1 AS val',
        params: ['hello'],
      });

      const wrappedSql = 'SELECT * FROM to_arrow_ipc((SELECT $1 AS val))';
      expect(run).toHaveBeenCalledWith(wrappedSql, ['hello']);
    });

    it('calls conn.run without params when none provided', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([]),
        })
        .mockResolvedValue({ getRows: vi.fn().mockResolvedValue([]) });
      mockGetConnection.mockReturnValue({ run });

      await handler({
        type: 'execute_query',
        queryId: 'q-no-params',
        sql: 'SELECT 1',
      });

      const wrappedSql = 'SELECT * FROM to_arrow_ipc((SELECT 1))';
      // Called with just one argument (no params)
      const firstCall = run.mock.calls[0]!;
      expect(firstCall[0]).toBe(wrappedSql);
      expect(firstCall).toHaveLength(1);
    });
  });

  // QA-026: Error messages must strip to_arrow_ipc() wrapper
  describe('stripArrowIpcWrapper strips wrapper from error messages (QA-026)', () => {
    it('strips to_arrow_ipc wrapper from DuckDB error messages', async () => {
      await loadWorker();
      const handler = getMessageHandler();

      const mockPort = { postMessage: vi.fn(), onmessage: null };
      await handler({ type: 'port', channel: 'duckdb-data', port: mockPort });

      // Simulate DuckDB throwing an error with the wrapper in the message
      const run = vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'Parser Error: syntax error at or near "typo"\n' +
              'LINE 1: SELECT * FROM to_arrow_ipc((SELCT typo FROM nonexistent))\n' +
              '                                    ^',
          ),
        );
      mockGetConnection.mockReturnValue({ run });

      await handler({
        type: 'execute_query',
        queryId: 'q-error',
        sql: 'SELCT typo FROM nonexistent',
      });

      const errorCall = mockPort.postMessage.mock.calls.find(
        (c: any[]) => c[0]?.type === 'arrow-error',
      );
      expect(errorCall).toBeDefined();
      const errorMsg = errorCall?.[0].message as string;
      // Must NOT contain to_arrow_ipc wrapper
      expect(errorMsg).not.toContain('to_arrow_ipc');
      // Must still contain the user's original SQL context
      expect(errorMsg).toContain('SELCT typo FROM nonexistent');
      expect(errorMsg).toContain('Parser Error');
    });
  });
});
