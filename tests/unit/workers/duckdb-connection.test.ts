import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock @duckdb/node-api
// --------------------------------------------------------------------------
const mockRun = vi.fn().mockResolvedValue({
  getRows: vi.fn().mockResolvedValue([]),
});
const mockCloseSync = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
  run: mockRun,
  closeSync: mockCloseSync,
});
const mockInstanceCloseSync = vi.fn();
const mockCreate = vi.fn().mockResolvedValue({
  connect: mockConnect,
  closeSync: mockInstanceCloseSync,
});

vi.mock('@duckdb/node-api', () => ({
  DuckDBInstance: {
    create: mockCreate,
  },
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
function baseConfig() {
  return {
    dbPath: '/tmp/test.duckdb',
    memoryLimit: '256MB',
    threads: 2,
    tempDirectory: '/tmp/duckdb-temp',
    extensions: ['parquet', 'json'],
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe('duckdb-connection', () => {
  let mod: typeof import('@workers/duckdb-connection');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset mock implementations to defaults after clearAllMocks
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

  // ========================================================================
  // initDuckDB
  // ========================================================================

  describe('initDuckDB', () => {
    it('creates DuckDB instance with correct config', async () => {
      const config = baseConfig();
      await mod.initDuckDB(config);

      expect(mockCreate).toHaveBeenCalledWith(config.dbPath, {
        access_mode: 'READ_WRITE',
        memory_limit: config.memoryLimit,
        threads: String(config.threads),
        temp_directory: config.tempDirectory,
      });
    });

    it('connects to the created instance', async () => {
      await mod.initDuckDB(baseConfig());

      expect(mockConnect).toHaveBeenCalledOnce();
    });

    it('loads all configured extensions', async () => {
      const config = baseConfig();
      config.extensions = ['parquet', 'json', 'icu'];

      await mod.initDuckDB(config);

      expect(mockRun).toHaveBeenCalledWith('LOAD parquet');
      expect(mockRun).toHaveBeenCalledWith('LOAD json');
      expect(mockRun).toHaveBeenCalledWith('LOAD icu');
    });

    it('creates _query_history system table', async () => {
      await mod.initDuckDB(baseConfig());

      const runCalls = mockRun.mock.calls.map((c: any[]) => c[0] as string);
      const createQueryHistory = runCalls.find((sql: string) =>
        sql.includes('CREATE TABLE IF NOT EXISTS _query_history'),
      );
      expect(createQueryHistory).toBeDefined();
      expect(createQueryHistory).toContain('query_id');
      expect(createQueryHistory).toContain('sql');
      expect(createQueryHistory).toContain('execution_time_ms');
    });

    it('creates _schema_version system table', async () => {
      await mod.initDuckDB(baseConfig());

      const runCalls = mockRun.mock.calls.map((c: any[]) => c[0] as string);
      const createSchemaVersion = runCalls.find((sql: string) =>
        sql.includes('CREATE TABLE IF NOT EXISTS _schema_version'),
      );
      expect(createSchemaVersion).toBeDefined();
      expect(createSchemaVersion).toContain('version');
      expect(createSchemaVersion).toContain('applied_at');
    });

    it('creates index on _query_history timestamp', async () => {
      await mod.initDuckDB(baseConfig());

      const runCalls = mockRun.mock.calls.map((c: any[]) => c[0] as string);
      const createIndex = runCalls.find((sql: string) =>
        sql.includes('CREATE INDEX IF NOT EXISTS idx_qh_timestamp'),
      );
      expect(createIndex).toBeDefined();
    });

    it('inserts initial schema version', async () => {
      await mod.initDuckDB(baseConfig());

      const runCalls = mockRun.mock.calls.map((c: any[]) => c[0] as string);
      const insertVersion = runCalls.find((sql: string) =>
        sql.includes('INSERT OR IGNORE INTO _schema_version'),
      );
      expect(insertVersion).toBeDefined();
      expect(insertVersion).toContain('1.0.0');
    });

    it('sets extension_directory when provided', async () => {
      const config = {
        ...baseConfig(),
        extensionDirectory: '/app/extensions',
      };

      await mod.initDuckDB(config);

      expect(mockRun).toHaveBeenCalledWith("SET extension_directory = '/app/extensions'");
    });

    it('does not set extension_directory when not provided', async () => {
      const config = baseConfig();
      await mod.initDuckDB(config);

      const runCalls = mockRun.mock.calls.map((c: any[]) => c[0] as string);
      const setExtDir = runCalls.find((sql: string) => sql.includes('SET extension_directory'));
      expect(setExtDir).toBeUndefined();
    });

    it('loads excel and arrow extensions with empty user extensions array', async () => {
      const config = { ...baseConfig(), extensions: [] };
      await mod.initDuckDB(config);

      const runCalls = mockRun.mock.calls.map((c: any[]) => c[0] as string);
      const loadCalls = runCalls.filter((sql: string) => sql.startsWith('LOAD '));
      // Excel and Arrow extensions are always installed/loaded even with no user extensions
      expect(loadCalls).toHaveLength(2);
      expect(loadCalls).toContain('LOAD excel');
      expect(loadCalls).toContain('LOAD arrow');
    });
  });

  // ========================================================================
  // getConnection / getInstance
  // ========================================================================

  describe('getConnection', () => {
    it('throws when not initialized', () => {
      expect(() => mod.getConnection()).toThrow('DuckDB not initialized');
    });

    it('returns connection after init', async () => {
      await mod.initDuckDB(baseConfig());
      const conn = mod.getConnection();

      expect(conn).toBeDefined();
      expect(conn.run).toBeTypeOf('function');
    });
  });

  // ========================================================================
  // runIntegrityCheck
  // ========================================================================

  describe('runIntegrityCheck', () => {
    it('throws when not initialized', async () => {
      await expect(mod.runIntegrityCheck()).rejects.toThrow('DuckDB not initialized');
    });

    it('returns true when SELECT 1 returns 1', async () => {
      await mod.initDuckDB(baseConfig());

      // After init, setup the integrity check mock (SELECT 1 AS ok → [[1]])
      mockRun.mockResolvedValueOnce({
        getRows: vi.fn().mockResolvedValue([[1]]),
      });

      const result = await mod.runIntegrityCheck();
      expect(result).toBe(true);
    });

    it('returns false when PRAGMA returns non-ok', async () => {
      await mod.initDuckDB(baseConfig());

      mockRun.mockResolvedValueOnce({
        getRows: vi.fn().mockResolvedValue([['damaged']]),
      });

      const result = await mod.runIntegrityCheck();
      expect(result).toBe(false);
    });

    it('returns false when PRAGMA throws', async () => {
      await mod.initDuckDB(baseConfig());

      mockRun.mockRejectedValueOnce(new Error('database corrupted'));

      const result = await mod.runIntegrityCheck();
      expect(result).toBe(false);
    });

    it('returns false when PRAGMA returns empty rows', async () => {
      await mod.initDuckDB(baseConfig());

      mockRun.mockResolvedValueOnce({
        getRows: vi.fn().mockResolvedValue([]),
      });

      const result = await mod.runIntegrityCheck();
      expect(result).toBe(false);
    });
  });

  // ========================================================================
  // closeDuckDB
  // ========================================================================

  describe('closeDuckDB', () => {
    it('checkpoints then nulls references', async () => {
      await mod.initDuckDB(baseConfig());
      mockRun.mockClear();

      await mod.closeDuckDB();

      // Should have called CHECKPOINT
      expect(mockRun).toHaveBeenCalledWith('CHECKPOINT');

      // After close, getConnection should throw
      expect(() => mod.getConnection()).toThrow('DuckDB not initialized');
    });

    it('does not throw when already closed', async () => {
      await expect(mod.closeDuckDB()).resolves.toBeUndefined();
    });

    it('handles checkpoint failure during close gracefully', async () => {
      await mod.initDuckDB(baseConfig());
      mockRun.mockRejectedValueOnce(new Error('CHECKPOINT failed'));

      // closeDuckDB should still complete even if checkpoint fails
      await expect(mod.closeDuckDB()).resolves.toBeUndefined();

      // References should still be nulled
      expect(() => mod.getConnection()).toThrow('DuckDB not initialized');
    });

    it('can re-initialize after close', async () => {
      await mod.initDuckDB(baseConfig());
      await mod.closeDuckDB();

      // Re-init
      await mod.initDuckDB(baseConfig());
      expect(() => mod.getConnection()).not.toThrow();
    });
  });
});
