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

      const ipcBuffer = new Uint8Array([1, 2, 3, 4]);
      const run = vi
        .fn()
        .mockResolvedValueOnce({
          getRows: vi.fn().mockResolvedValue([[ipcBuffer]]),
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
      // Must NOT have __transferredBuffers
      expect(batchCall?.[0]).not.toHaveProperty('__transferredBuffers');
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
});
