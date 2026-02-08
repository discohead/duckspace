import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock @duckdb/node-api with closeSync methods
// --------------------------------------------------------------------------
const mockCloseSync = vi.fn();
const mockInstanceCloseSync = vi.fn();

const mockRun = vi.fn().mockResolvedValue({
  getRows: vi.fn().mockResolvedValue([]),
});
const mockConnect = vi.fn().mockResolvedValue({
  run: mockRun,
  closeSync: mockCloseSync,
});
const mockCreate = vi.fn().mockResolvedValue({
  connect: mockConnect,
  closeSync: mockInstanceCloseSync,
});

vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create: mockCreate,
  },
}));

function baseConfig() {
  return {
    dbPath: '/tmp/test.duckdb',
    memoryLimit: '256MB',
    threads: 2,
    tempDirectory: '/tmp/duckdb-temp',
    extensions: [],
  };
}

describe('duckdb-connection — Regression', () => {
  let mod: typeof import('@workers/duckdb-connection');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockRun.mockResolvedValue({
      getRows: vi.fn().mockResolvedValue([]),
    });
    mockConnect.mockResolvedValue({
      run: mockRun,
      closeSync: mockCloseSync,
    });
    mockCreate.mockResolvedValue({
      connect: mockConnect,
      closeSync: mockInstanceCloseSync,
    });

    mod = await import('@workers/duckdb-connection');
  });

  // #13: closeDuckDB must call native close methods
  describe('closeDuckDB calls native close methods (#13)', () => {
    it('calls connection.closeSync() during close', async () => {
      await mod.initDuckDB(baseConfig());
      await mod.closeDuckDB();

      expect(mockCloseSync).toHaveBeenCalledOnce();
    });

    it('calls instance.closeSync() during close', async () => {
      await mod.initDuckDB(baseConfig());
      await mod.closeDuckDB();

      expect(mockInstanceCloseSync).toHaveBeenCalledOnce();
    });

    it('calls connection.closeSync() before instance.closeSync()', async () => {
      const callOrder: string[] = [];
      mockCloseSync.mockImplementation(() => callOrder.push('connection.closeSync'));
      mockInstanceCloseSync.mockImplementation(() => callOrder.push('instance.closeSync'));

      await mod.initDuckDB(baseConfig());
      await mod.closeDuckDB();

      expect(callOrder).toEqual(['connection.closeSync', 'instance.closeSync']);
    });

    it('still checkpoints before closing', async () => {
      await mod.initDuckDB(baseConfig());
      mockRun.mockClear();

      await mod.closeDuckDB();

      expect(mockRun).toHaveBeenCalledWith('CHECKPOINT');
    });
  });
});
