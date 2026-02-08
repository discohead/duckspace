// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import type { CatalogEntry, ColumnSchema } from '@shared/types';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Import the real DatspaceDB class directly (not from the mocked module)
// We need a fresh db for each test, but recovery.ts imports db as a singleton.
// Strategy: use vi.mock with a mutable reference that we swap per test.
let testDb: InstanceType<typeof import('@renderer/stores/db').DatspaceDB>;

vi.mock('@renderer/stores/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/db')>();
  return {
    ...actual,
    DatspaceDB: actual.DatspaceDB,
    default: new Proxy(
      {},
      {
        get(_target, prop) {
          return (testDb as unknown as Record<string, unknown>)[prop as string];
        },
      },
    ),
  };
});

// Import after mock setup
const { DatspaceDB } = await import('@renderer/stores/db');
const { checkAndRecover, writeRecoveryLog } = await import('@renderer/lib/recovery');

// Mock window.datspace
const mockGetAppState = vi.fn();
const mockListTables = vi.fn();
const mockDescribeTable = vi.fn();

beforeEach(async () => {
  testDb = new DatspaceDB();
  await testDb.open();

  mockGetAppState.mockResolvedValue({
    version: '1.0.0',
    electronVersion: '33.0.0',
    platform: 'darwin',
    arch: 'arm64',
    userDataPath: '/tmp/test',
    memory: { totalSystemMB: 16384, freeSystemMB: 8192, duckdbLimitMB: 4096 },
    workers: { duckdb: 'ready' },
    shutdownStatus: 'clean',
  });
  mockListTables.mockResolvedValue([]);
  mockDescribeTable.mockResolvedValue([]);

  Object.defineProperty(window, 'datspace', {
    value: {
      lifecycle: { getAppState: mockGetAppState },
      catalog: { listTables: mockListTables, describeTable: mockDescribeTable },
    },
    writable: true,
    configurable: true,
  });

  // Stub crypto.randomUUID
  let uuidCounter = 0;
  vi.stubGlobal('crypto', {
    ...globalThis.crypto,
    randomUUID: () => `test-uuid-${++uuidCounter}`,
  });
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete('Datspace');
  vi.restoreAllMocks();
});

describe('checkAndRecover', () => {
  it('returns false when no shutdown_status exists', async () => {
    const result = await checkAndRecover();
    expect(result).toBe(false);
  });

  it('returns false when shutdown_status is clean', async () => {
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'clean',
      updatedAt: new Date().toISOString(),
    });

    const result = await checkAndRecover();
    expect(result).toBe(false);
  });

  it('returns true when shutdown_status is dirty', async () => {
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'dirty',
      updatedAt: new Date().toISOString(),
    });

    const result = await checkAndRecover();
    expect(result).toBe(true);
  });

  it('writes abnormal_shutdown recovery log entry when dirty', async () => {
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'dirty',
      updatedAt: new Date().toISOString(),
    });

    await checkAndRecover();

    const logs = await testDb.recovery_log.toArray();
    const shutdownLog = logs.find((l) => l.type === 'abnormal_shutdown');
    expect(shutdownLog).toBeDefined();
    expect(shutdownLog?.outcome).toBe('recovered');
    expect(shutdownLog?.details).toContain('did not shut down cleanly');
  });

  it('calls getAppState and writes integrity_check log when dirty', async () => {
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'dirty',
      updatedAt: new Date().toISOString(),
    });

    await checkAndRecover();

    expect(mockGetAppState).toHaveBeenCalledTimes(1);

    const logs = await testDb.recovery_log.toArray();
    const integrityLog = logs.find((l) => l.type === 'integrity_check');
    expect(integrityLog).toBeDefined();
    expect(integrityLog?.outcome).toBe('recovered');
    expect(integrityLog?.details).toContain('integrity check passed');
    expect(integrityLog?.affectedWorker).toBe('duckdb');
  });

  it('calls reconcileCatalog when dirty', async () => {
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'dirty',
      updatedAt: new Date().toISOString(),
    });

    await checkAndRecover();

    expect(mockListTables).toHaveBeenCalledTimes(1);

    const logs = await testDb.recovery_log.toArray();
    const walLog = logs.find((l) => l.type === 'wal_recovery');
    expect(walLog).toBeDefined();
    expect(walLog?.details).toContain('Catalog reconciliation complete');
  });

  it('writes degraded integrity_check log when getAppState throws', async () => {
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'dirty',
      updatedAt: new Date().toISOString(),
    });
    mockGetAppState.mockRejectedValue(new Error('Worker not responding'));

    await checkAndRecover();

    const logs = await testDb.recovery_log.toArray();
    const integrityLog = logs.find((l) => l.type === 'integrity_check');
    expect(integrityLog).toBeDefined();
    expect(integrityLog?.outcome).toBe('degraded');
    expect(integrityLog?.details).toContain('could not be verified');
  });
});

describe('writeRecoveryLog', () => {
  it('adds entry with UUID and timestamp', async () => {
    await writeRecoveryLog({
      type: 'worker_restart',
      details: 'Worker restarted after crash',
      outcome: 'recovered',
      affectedWorker: 'duckdb',
    });

    const logs = await testDb.recovery_log.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.id).toMatch(/^test-uuid-/);
    expect(logs[0]!.timestamp).toBeDefined();
    expect(new Date(logs[0]!.timestamp).getTime()).not.toBeNaN();
    expect(logs[0]!.type).toBe('worker_restart');
    expect(logs[0]!.outcome).toBe('recovered');
    expect(logs[0]!.affectedWorker).toBe('duckdb');
  });

  it('writes multiple log entries with unique IDs', async () => {
    await writeRecoveryLog({
      type: 'abnormal_shutdown',
      details: 'First entry',
      outcome: 'recovered',
    });
    await writeRecoveryLog({
      type: 'integrity_check',
      details: 'Second entry',
      outcome: 'degraded',
    });

    const logs = await testDb.recovery_log.toArray();
    expect(logs).toHaveLength(2);
    expect(logs[0]!.id).not.toBe(logs[1]!.id);
  });
});

describe('reconcileCatalog (via checkAndRecover)', () => {
  beforeEach(async () => {
    // Set dirty shutdown so reconcileCatalog runs
    await testDb.app_state.put({
      id: 'shutdown_status',
      value: 'dirty',
      updatedAt: new Date().toISOString(),
    });
  });

  it('creates missing entries for tables in DuckDB but not in Dexie', async () => {
    const duckdbTable: CatalogEntry = {
      id: 'duck-1',
      name: 'new_table',
      schema: 'main',
      type: 'table',
      status: 'active',
      rowCount: 50,
      sizeBytes: 2048,
      columnCount: 3,
      registeredAt: '2025-01-01T00:00:00Z',
    };
    mockListTables.mockResolvedValue([duckdbTable]);

    const columns: ColumnSchema[] = [
      {
        name: 'id',
        duckdbType: 'INTEGER',
        arrowType: 'Int32',
        nullable: false,
        ordinalPosition: 0,
      },
      {
        name: 'name',
        duckdbType: 'VARCHAR',
        arrowType: 'Utf8',
        nullable: true,
        ordinalPosition: 1,
      },
    ];
    mockDescribeTable.mockResolvedValue(columns);

    await checkAndRecover();

    // Verify catalog entry was created
    const entries = await testDb.catalog_entries.toArray();
    const newEntry = entries.find((e) => e.name === 'new_table');
    expect(newEntry).toBeDefined();
    expect(newEntry?.status).toBe('active');
    expect(newEntry?.type).toBe('table');
    expect(newEntry?.rowCount).toBe(50);

    // Verify column schemas were created
    const colSchemas = await testDb.column_schemas.toArray();
    expect(colSchemas).toHaveLength(2);
    expect(colSchemas.map((c) => c.columnName).sort()).toEqual(['id', 'name']);
  });

  it('marks orphaned entries as removed (in Dexie but not DuckDB)', async () => {
    // Add an entry to Dexie that does not exist in DuckDB
    const orphanEntry: CatalogEntry = {
      id: 'cat-orphan',
      name: 'deleted_table',
      schema: 'main',
      type: 'table',
      status: 'active',
      rowCount: 10,
      sizeBytes: 512,
      columnCount: 2,
      registeredAt: '2025-01-01T00:00:00Z',
    };
    await testDb.catalog_entries.add(orphanEntry);

    mockListTables.mockResolvedValue([]); // DuckDB has no tables

    await checkAndRecover();

    const entry = await testDb.catalog_entries.get('cat-orphan');
    expect(entry?.status).toBe('removed');
  });

  it('does not mark already-removed entries again', async () => {
    const alreadyRemoved: CatalogEntry = {
      id: 'cat-old',
      name: 'old_table',
      schema: 'main',
      type: 'table',
      status: 'removed',
      rowCount: 0,
      sizeBytes: 0,
      columnCount: 0,
      registeredAt: '2025-01-01T00:00:00Z',
    };
    await testDb.catalog_entries.add(alreadyRemoved);

    mockListTables.mockResolvedValue([]);

    await checkAndRecover();

    // Status should remain 'removed', not trigger another update
    const entry = await testDb.catalog_entries.get('cat-old');
    expect(entry?.status).toBe('removed');
  });

  it('handles listTables errors gracefully', async () => {
    mockListTables.mockRejectedValue(new Error('DuckDB unavailable'));

    // Should not throw
    await checkAndRecover();

    const logs = await testDb.recovery_log.toArray();
    const walLog = logs.find((l) => l.type === 'wal_recovery');
    expect(walLog).toBeDefined();
    expect(walLog?.outcome).toBe('degraded');
    expect(walLog?.details).toContain('reconciliation failed');
  });

  it('handles describeTable errors gracefully (best effort)', async () => {
    const duckdbTable: CatalogEntry = {
      id: 'duck-1',
      name: 'problematic_table',
      schema: 'main',
      type: 'table',
      status: 'active',
      rowCount: 100,
      sizeBytes: 4096,
      columnCount: 5,
      registeredAt: '2025-01-01T00:00:00Z',
    };
    mockListTables.mockResolvedValue([duckdbTable]);
    mockDescribeTable.mockRejectedValue(new Error('Cannot describe'));

    await checkAndRecover();

    // The catalog entry should still be created even if columns fail
    const entries = await testDb.catalog_entries.toArray();
    const entry = entries.find((e) => e.name === 'problematic_table');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('active');

    // No column schemas should exist since describeTable failed
    const colSchemas = await testDb.column_schemas.toArray();
    expect(colSchemas).toHaveLength(0);
  });
});
