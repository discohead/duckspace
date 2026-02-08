import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { DatspaceDB } from '@renderer/stores/db';
import type {
  AppStateEntry,
  CatalogEntry,
  ColumnSchemaRecord,
  Preference,
  Query,
  QueryHistoryRecord,
  RecoveryLogEntry,
  Tab,
  WorkerHealthRecord,
} from '@shared/types';
import Dexie from 'dexie';

let testDb: DatspaceDB;

beforeEach(async () => {
  testDb = new DatspaceDB();
  await testDb.open();
});

afterEach(async () => {
  testDb.close();
  await Dexie.delete('Datspace');
});

describe('DatspaceDB', () => {
  describe('database initialization', () => {
    it('can be opened', () => {
      expect(testDb.isOpen()).toBe(true);
    });

    it('has all 13 tables', () => {
      const tableNames = testDb.tables.map((t) => t.name).sort();
      expect(tableNames).toEqual([
        'app_state',
        'catalog_entries',
        'column_schemas',
        'column_statistics',
        'data_sources',
        'ingestion_jobs',
        'preferences',
        'queries',
        'query_history',
        'recovery_log',
        'tabs',
        'watch_directories',
        'worker_health',
      ]);
    });
  });

  describe('tabs CRUD', () => {
    const sampleTab: Tab = {
      id: 'tab-1',
      type: 'query',
      order: 0,
      title: 'Query 1',
      active: true,
      state: { sql: 'SELECT 1' },
      lastAccessedAt: '2025-01-01T00:00:00Z',
    };

    it('can add and retrieve a tab', async () => {
      await testDb.tabs.add(sampleTab);
      const result = await testDb.tabs.get('tab-1');
      expect(result).toEqual(sampleTab);
    });

    it('can update a tab', async () => {
      await testDb.tabs.add(sampleTab);
      await testDb.tabs.update('tab-1', { title: 'Renamed Tab' });
      const result = await testDb.tabs.get('tab-1');
      expect(result?.title).toBe('Renamed Tab');
    });

    it('can delete a tab', async () => {
      await testDb.tabs.add(sampleTab);
      await testDb.tabs.delete('tab-1');
      const result = await testDb.tabs.get('tab-1');
      expect(result).toBeUndefined();
    });

    it('can order tabs by the order index', async () => {
      const tab2: Tab = { ...sampleTab, id: 'tab-2', order: 1, title: 'Query 2', active: false };
      const tab3: Tab = { ...sampleTab, id: 'tab-3', order: 2, title: 'Query 3', active: false };
      await testDb.tabs.bulkAdd([tab3, sampleTab, tab2]);

      const ordered = await testDb.tabs.orderBy('order').toArray();
      expect(ordered.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3']);
    });
  });

  describe('queries CRUD', () => {
    const sampleQuery: Query = {
      id: 'q-1',
      tabId: 'tab-1',
      sql: 'SELECT * FROM t',
      status: 'running',
      startedAt: '2025-01-01T00:00:00Z',
    };

    it('can add and retrieve a query', async () => {
      await testDb.queries.add(sampleQuery);
      const result = await testDb.queries.get('q-1');
      expect(result).toEqual(sampleQuery);
    });

    it('can query by status index', async () => {
      const completed: Query = { ...sampleQuery, id: 'q-2', status: 'completed' };
      await testDb.queries.bulkAdd([sampleQuery, completed]);

      const running = await testDb.queries.where('status').equals('running').toArray();
      expect(running).toHaveLength(1);
      expect(running[0]!.id).toBe('q-1');
    });

    it('can query by tabId index', async () => {
      const otherTab: Query = { ...sampleQuery, id: 'q-2', tabId: 'tab-2' };
      await testDb.queries.bulkAdd([sampleQuery, otherTab]);

      const tab1Queries = await testDb.queries.where('tabId').equals('tab-1').toArray();
      expect(tab1Queries).toHaveLength(1);
      expect(tab1Queries[0]!.id).toBe('q-1');
    });
  });

  describe('catalog_entries CRUD', () => {
    const sampleEntry: CatalogEntry = {
      id: 'cat-1',
      name: 'users',
      schema: 'main',
      type: 'table',
      status: 'active',
      rowCount: 100,
      sizeBytes: 4096,
      columnCount: 5,
      registeredAt: '2025-01-01T00:00:00Z',
    };

    it('can add and retrieve a catalog entry', async () => {
      await testDb.catalog_entries.add(sampleEntry);
      const result = await testDb.catalog_entries.get('cat-1');
      expect(result).toEqual(sampleEntry);
    });

    it('can query by status index', async () => {
      const removed: CatalogEntry = {
        ...sampleEntry,
        id: 'cat-2',
        name: 'old_table',
        status: 'removed',
      };
      await testDb.catalog_entries.bulkAdd([sampleEntry, removed]);

      const active = await testDb.catalog_entries.where('status').equals('active').toArray();
      expect(active).toHaveLength(1);
      expect(active[0]!.name).toBe('users');
    });

    it('can query by name index', async () => {
      await testDb.catalog_entries.add(sampleEntry);
      const result = await testDb.catalog_entries.where('name').equals('users').toArray();
      expect(result).toHaveLength(1);
    });
  });

  describe('column_schemas CRUD and compound index', () => {
    const sampleColumn: ColumnSchemaRecord = {
      id: 'cat-1_name',
      catalogEntryId: 'cat-1',
      columnName: 'name',
      columnType: 'VARCHAR',
      arrowType: 'Utf8',
      nullable: false,
      ordinalPosition: 0,
    };

    it('can add and retrieve a column schema', async () => {
      await testDb.column_schemas.add(sampleColumn);
      const result = await testDb.column_schemas.get('cat-1_name');
      expect(result).toEqual(sampleColumn);
    });

    it('can query by catalogEntryId index', async () => {
      const col2: ColumnSchemaRecord = {
        ...sampleColumn,
        id: 'cat-1_age',
        columnName: 'age',
        columnType: 'INTEGER',
        arrowType: 'Int32',
        ordinalPosition: 1,
      };
      const otherEntry: ColumnSchemaRecord = {
        ...sampleColumn,
        id: 'cat-2_id',
        catalogEntryId: 'cat-2',
        columnName: 'id',
        ordinalPosition: 0,
      };
      await testDb.column_schemas.bulkAdd([sampleColumn, col2, otherEntry]);

      const cat1Cols = await testDb.column_schemas
        .where('catalogEntryId')
        .equals('cat-1')
        .toArray();
      expect(cat1Cols).toHaveLength(2);
    });

    it('compound index [catalogEntryId+columnName] works', async () => {
      await testDb.column_schemas.add(sampleColumn);
      const result = await testDb.column_schemas
        .where('[catalogEntryId+columnName]')
        .equals(['cat-1', 'name'])
        .first();
      expect(result).toEqual(sampleColumn);
    });

    it('compound index returns undefined for non-existent combination', async () => {
      await testDb.column_schemas.add(sampleColumn);
      const result = await testDb.column_schemas
        .where('[catalogEntryId+columnName]')
        .equals(['cat-1', 'nonexistent'])
        .first();
      expect(result).toBeUndefined();
    });
  });

  describe('query_history CRUD and multi-entry index', () => {
    const sampleHistory: QueryHistoryRecord = {
      id: 'qh-1',
      sql: 'SELECT 1',
      executionTimeMs: 42,
      rowCount: 1,
      timestamp: '2025-01-01T00:00:00Z',
      source: 'user',
      tags: ['favorite', 'analytics'],
      status: 'success',
    };

    it('can add and retrieve a history record', async () => {
      await testDb.query_history.add(sampleHistory);
      const result = await testDb.query_history.get('qh-1');
      expect(result).toEqual(sampleHistory);
    });

    it('multi-entry index on tags works', async () => {
      const otherHistory: QueryHistoryRecord = {
        ...sampleHistory,
        id: 'qh-2',
        tags: ['analytics', 'debug'],
      };
      await testDb.query_history.bulkAdd([sampleHistory, otherHistory]);

      const analyticsQueries = await testDb.query_history
        .where('tags')
        .equals('analytics')
        .toArray();
      expect(analyticsQueries).toHaveLength(2);

      const favoriteQueries = await testDb.query_history.where('tags').equals('favorite').toArray();
      expect(favoriteQueries).toHaveLength(1);
      expect(favoriteQueries[0]!.id).toBe('qh-1');
    });

    it('multi-entry index returns empty for unused tag', async () => {
      await testDb.query_history.add(sampleHistory);
      const result = await testDb.query_history.where('tags').equals('nonexistent').toArray();
      expect(result).toHaveLength(0);
    });
  });

  describe('preferences CRUD', () => {
    const samplePref: Preference = {
      id: 'appearance.theme',
      value: 'dark',
      category: 'appearance',
      updatedAt: '2025-01-01T00:00:00Z',
    };

    it('can add and retrieve a preference', async () => {
      await testDb.preferences.add(samplePref);
      const result = await testDb.preferences.get('appearance.theme');
      expect(result).toEqual(samplePref);
    });

    it('can update a preference value', async () => {
      await testDb.preferences.add(samplePref);
      await testDb.preferences.update('appearance.theme', { value: 'light' });
      const result = await testDb.preferences.get('appearance.theme');
      expect(result?.value).toBe('light');
    });
  });

  describe('worker_health CRUD', () => {
    const sampleHealth: WorkerHealthRecord = {
      id: 'duckdb',
      status: 'ready',
      restartCount: 0,
      lastHeartbeatAt: '2025-01-01T00:00:00Z',
      upSince: '2025-01-01T00:00:00Z',
      activeQueryCount: 0,
    };

    it('can add and retrieve worker health', async () => {
      await testDb.worker_health.add(sampleHealth);
      const result = await testDb.worker_health.get('duckdb');
      expect(result).toEqual(sampleHealth);
    });

    it('can update worker health status', async () => {
      await testDb.worker_health.add(sampleHealth);
      await testDb.worker_health.update('duckdb', { status: 'degraded', activeQueryCount: 2 });
      const result = await testDb.worker_health.get('duckdb');
      expect(result?.status).toBe('degraded');
      expect(result?.activeQueryCount).toBe(2);
    });
  });

  describe('recovery_log CRUD', () => {
    const sampleLog: RecoveryLogEntry = {
      id: 'rl-1',
      timestamp: '2025-01-01T00:00:00Z',
      type: 'abnormal_shutdown',
      details: 'Previous session did not shut down cleanly.',
      outcome: 'recovered',
    };

    it('can add and retrieve a recovery log entry', async () => {
      await testDb.recovery_log.add(sampleLog);
      const result = await testDb.recovery_log.get('rl-1');
      expect(result).toEqual(sampleLog);
    });

    it('can query by timestamp index', async () => {
      const laterLog: RecoveryLogEntry = {
        ...sampleLog,
        id: 'rl-2',
        timestamp: '2025-01-02T00:00:00Z',
        type: 'integrity_check',
      };
      await testDb.recovery_log.bulkAdd([sampleLog, laterLog]);

      const ordered = await testDb.recovery_log.orderBy('timestamp').toArray();
      expect(ordered.map((r) => r.id)).toEqual(['rl-1', 'rl-2']);
    });
  });

  describe('app_state CRUD', () => {
    const sampleState: AppStateEntry = {
      id: 'shutdown_status',
      value: 'clean',
      updatedAt: '2025-01-01T00:00:00Z',
    };

    it('can add and retrieve app state', async () => {
      await testDb.app_state.add(sampleState);
      const result = await testDb.app_state.get('shutdown_status');
      expect(result).toEqual(sampleState);
    });

    it('can use put to upsert app state', async () => {
      await testDb.app_state.put(sampleState);
      await testDb.app_state.put({ ...sampleState, value: 'dirty' });
      const result = await testDb.app_state.get('shutdown_status');
      expect(result?.value).toBe('dirty');
    });
  });
});
