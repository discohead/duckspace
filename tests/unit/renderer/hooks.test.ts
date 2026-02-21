import { beforeEach, describe, expect, it, vi } from 'vitest';

// Use vi.hoisted so mock references are available when vi.mock factories run (hoisted above imports)
const {
  mockUseLiveQuery,
  mockToArray,
  mockFirst,
  mockSortBy,
  mockReverse,
  mockEquals,
  mockWhere,
  mockFilter,
  mockOrderBy,
  mockGet,
  mockDb,
} = vi.hoisted(() => {
  const mockToArray = vi.fn();
  const mockFirst = vi.fn();
  const mockSortBy = vi.fn();
  const mockReverse = vi.fn().mockReturnValue({ sortBy: mockSortBy, toArray: mockToArray });
  const mockEquals = vi.fn().mockReturnValue({
    toArray: mockToArray,
    reverse: mockReverse,
    sortBy: mockSortBy,
    delete: vi.fn(),
  });
  const mockWhere = vi.fn().mockReturnValue({ equals: mockEquals });
  const mockFilter = vi.fn().mockReturnValue({ first: mockFirst, sortBy: mockSortBy });
  const mockOrderBy = vi.fn().mockReturnValue({ toArray: mockToArray, reverse: mockReverse });
  const mockGet = vi.fn();
  const mockUseLiveQuery = vi.fn();

  return {
    mockUseLiveQuery,
    mockToArray,
    mockFirst,
    mockSortBy,
    mockReverse,
    mockEquals,
    mockWhere,
    mockFilter,
    mockOrderBy,
    mockGet,
    mockDb: {
      tabs: { orderBy: mockOrderBy, filter: mockFilter },
      worker_health: { get: mockGet },
      preferences: { get: mockGet },
      app_state: { get: mockGet },
      queries: { where: mockWhere },
      catalog_entries: { where: mockWhere },
      column_schemas: { where: mockWhere },
      data_sources: {
        toCollection: vi.fn().mockReturnValue({ sortBy: mockSortBy }),
        where: mockWhere,
        get: mockGet,
      },
      ingestion_jobs: {
        where: mockWhere,
        orderBy: mockOrderBy,
      },
      column_statistics: { where: mockWhere },
      watch_directories: {
        filter: mockFilter,
        orderBy: mockOrderBy,
      },
    },
  };
});

// Mock dexie-react-hooks
vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: (...args: unknown[]) => mockUseLiveQuery(...args),
}));

// Mock db module
vi.mock('@renderer/stores/db', () => ({ db: mockDb }));

import {
  useActiveTab,
  useAppState,
  useCatalogEntries,
  useCatalogSources,
  useColumnSchemas,
  useColumnStats,
  useCurrentQuery,
  useDataSource,
  useIngestionJobs,
  usePreference,
  useRunningQueries,
  useTabs,
  useWatchDirectories,
  useWorkerHealth,
} from '@renderer/stores/hooks';

beforeEach(() => {
  vi.clearAllMocks();
  // By default, execute the query function passed to useLiveQuery
  mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn());
});

describe('useTabs', () => {
  it('calls useLiveQuery with a query function', () => {
    useTabs();
    expect(mockUseLiveQuery).toHaveBeenCalledTimes(1);
  });

  it('query function calls db.tabs.orderBy("order").toArray()', () => {
    useTabs();
    expect(mockOrderBy).toHaveBeenCalledWith('order');
    expect(mockToArray).toHaveBeenCalled();
  });
});

describe('useActiveTab', () => {
  it('calls useLiveQuery with a query function', () => {
    useActiveTab();
    expect(mockUseLiveQuery).toHaveBeenCalledTimes(1);
  });

  it('query function calls db.tabs.filter(...).first()', () => {
    useActiveTab();
    expect(mockFilter).toHaveBeenCalledWith(expect.any(Function));
    expect(mockFirst).toHaveBeenCalled();
  });

  it('filter function selects tabs where active is true', () => {
    useActiveTab();
    const filterFn = mockFilter.mock.calls[0]![0];
    expect(filterFn({ active: true })).toBe(true);
    expect(filterFn({ active: false })).toBe(false);
  });
});

describe('useWorkerHealth', () => {
  it('calls useLiveQuery with a query function', () => {
    useWorkerHealth();
    expect(mockUseLiveQuery).toHaveBeenCalledTimes(1);
  });

  it('query function calls db.worker_health.get("duckdb")', () => {
    useWorkerHealth();
    expect(mockGet).toHaveBeenCalledWith('duckdb');
  });
});

describe('usePreference', () => {
  it('calls useLiveQuery with deps array containing the key', () => {
    usePreference('appearance.theme', 'light');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(
      expect.any(Function),
      ['appearance.theme'],
      'light',
    );
  });

  it('query function calls db.preferences.get with the key', async () => {
    mockGet.mockResolvedValue({ id: 'appearance.theme', value: 'dark' });
    mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn());
    const result = usePreference('appearance.theme', 'light');
    expect(mockGet).toHaveBeenCalledWith('appearance.theme');
    expect(result).toBeDefined();
  });

  it('returns defaultValue when preference not found', async () => {
    mockGet.mockResolvedValue(undefined);
    mockUseLiveQuery.mockImplementation(() => {
      // Simulate useLiveQuery returning undefined while async resolves
      return undefined;
    });
    const result = usePreference('missing.key', 'fallback');
    // When useLiveQuery returns undefined, the hook falls back to defaultValue
    expect(result).toBe('fallback');
  });
});

describe('useAppState', () => {
  it('calls useLiveQuery with deps array containing the key', () => {
    useAppState('shutdown_status');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['shutdown_status']);
  });

  it('query function calls db.app_state.get with the key', () => {
    useAppState('shutdown_status');
    expect(mockGet).toHaveBeenCalledWith('shutdown_status');
  });
});

describe('useRunningQueries', () => {
  it('calls useLiveQuery with a query function', () => {
    useRunningQueries();
    expect(mockUseLiveQuery).toHaveBeenCalledTimes(1);
  });

  it('query function calls db.queries.where("status").equals("running").toArray()', () => {
    useRunningQueries();
    expect(mockWhere).toHaveBeenCalledWith('status');
    expect(mockEquals).toHaveBeenCalledWith('running');
    expect(mockToArray).toHaveBeenCalled();
  });
});

describe('useCurrentQuery', () => {
  it('calls useLiveQuery with deps array containing tabId', () => {
    mockSortBy.mockResolvedValue([]);
    useCurrentQuery('tab-1');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['tab-1']);
  });

  it('query function calls db.queries.where("tabId").equals(tabId).reverse().sortBy("startedAt")', () => {
    mockSortBy.mockResolvedValue([]);
    useCurrentQuery('tab-1');
    expect(mockWhere).toHaveBeenCalledWith('tabId');
    expect(mockEquals).toHaveBeenCalledWith('tab-1');
    expect(mockReverse).toHaveBeenCalled();
    expect(mockSortBy).toHaveBeenCalledWith('startedAt');
  });
});

describe('useCatalogEntries', () => {
  it('calls useLiveQuery with a query function', () => {
    useCatalogEntries();
    expect(mockUseLiveQuery).toHaveBeenCalledTimes(1);
  });

  it('query function calls db.catalog_entries.where("status").equals("active").sortBy("name")', () => {
    useCatalogEntries();
    expect(mockWhere).toHaveBeenCalledWith('status');
    expect(mockEquals).toHaveBeenCalledWith('active');
    expect(mockSortBy).toHaveBeenCalledWith('name');
  });
});

describe('useColumnSchemas', () => {
  it('calls useLiveQuery with deps array containing catalogEntryId', () => {
    useColumnSchemas('cat-1');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['cat-1']);
  });

  it('query function calls db.column_schemas.where("catalogEntryId").equals(id).sortBy("ordinalPosition")', () => {
    useColumnSchemas('cat-1');
    expect(mockWhere).toHaveBeenCalledWith('catalogEntryId');
    expect(mockEquals).toHaveBeenCalledWith('cat-1');
    expect(mockSortBy).toHaveBeenCalledWith('ordinalPosition');
  });
});

describe('useCatalogSources', () => {
  it('calls useLiveQuery with deps containing status and format', () => {
    useCatalogSources({ status: 'active', format: 'csv' });
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['active', 'csv']);
  });

  it('without filters, queries entire collection sorted by createdAt', () => {
    useCatalogSources();
    expect(mockDb.data_sources.toCollection).toHaveBeenCalled();
    expect(mockSortBy).toHaveBeenCalledWith('createdAt');
  });

  it('with status filter, uses where/equals instead of toCollection', () => {
    useCatalogSources({ status: 'active' });
    expect(mockWhere).toHaveBeenCalledWith('status');
    expect(mockEquals).toHaveBeenCalledWith('active');
  });

  it('with format filter, filters results after sorting', async () => {
    const mockResults = [
      { format: 'csv', name: 'a.csv' },
      { format: 'parquet', name: 'b.parquet' },
    ];
    mockSortBy.mockResolvedValue(mockResults);
    mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn());
    const result = await useCatalogSources({ format: 'csv' });
    expect(result).toEqual([{ format: 'csv', name: 'a.csv' }]);
  });
});

describe('useIngestionJobs', () => {
  it('without filter, calls orderBy("startedAt").reverse().toArray()', () => {
    useIngestionJobs();
    expect(mockOrderBy).toHaveBeenCalledWith('startedAt');
    expect(mockReverse).toHaveBeenCalled();
    expect(mockToArray).toHaveBeenCalled();
  });

  it('with status filter, uses where/equals', () => {
    useIngestionJobs('running');
    expect(mockWhere).toHaveBeenCalledWith('status');
    expect(mockEquals).toHaveBeenCalledWith('running');
    expect(mockReverse).toHaveBeenCalled();
    expect(mockSortBy).toHaveBeenCalledWith('startedAt');
  });

  it('passes statusFilter as deps', () => {
    useIngestionJobs('failed');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['failed']);
  });
});

describe('useColumnStats', () => {
  it('with dataSourceId, queries column_statistics by dataSourceId', () => {
    useColumnStats('ds-1');
    expect(mockWhere).toHaveBeenCalledWith('dataSourceId');
    expect(mockEquals).toHaveBeenCalledWith('ds-1');
    expect(mockToArray).toHaveBeenCalled();
  });

  it('with undefined dataSourceId, returns empty array', async () => {
    mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn());
    const result = await useColumnStats(undefined);
    expect(result).toEqual([]);
  });

  it('passes dataSourceId as deps', () => {
    useColumnStats('ds-1');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['ds-1']);
  });
});

describe('useDataSource', () => {
  it('with dataSourceId, calls db.data_sources.get', () => {
    useDataSource('ds-1');
    expect(mockGet).toHaveBeenCalledWith('ds-1');
  });

  it('with undefined dataSourceId, returns undefined', async () => {
    mockUseLiveQuery.mockImplementation((fn: () => unknown) => fn());
    const result = await useDataSource(undefined);
    expect(result).toBeUndefined();
  });

  it('passes dataSourceId as deps', () => {
    useDataSource('ds-1');
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), ['ds-1']);
  });
});

describe('useWatchDirectories', () => {
  it('without activeOnly, calls orderBy("createdAt").toArray()', () => {
    useWatchDirectories();
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt');
    expect(mockToArray).toHaveBeenCalled();
  });

  it('with activeOnly=true, filters by isActive and sorts by createdAt', () => {
    useWatchDirectories(true);
    expect(mockFilter).toHaveBeenCalledWith(expect.any(Function));
    expect(mockSortBy).toHaveBeenCalledWith('createdAt');
  });

  it('filter function checks isActive property', () => {
    useWatchDirectories(true);
    const filterFn = mockFilter.mock.calls[0]![0];
    expect(filterFn({ isActive: true })).toBe(true);
    expect(filterFn({ isActive: false })).toBe(false);
  });

  it('passes activeOnly as deps', () => {
    useWatchDirectories(true);
    expect(mockUseLiveQuery).toHaveBeenCalledWith(expect.any(Function), [true]);
  });
});
