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
  const mockReverse = vi.fn().mockReturnValue({ sortBy: mockSortBy });
  const mockEquals = vi.fn().mockReturnValue({
    toArray: mockToArray,
    reverse: mockReverse,
    sortBy: mockSortBy,
  });
  const mockWhere = vi.fn().mockReturnValue({ equals: mockEquals });
  const mockFilter = vi.fn().mockReturnValue({ first: mockFirst });
  const mockOrderBy = vi.fn().mockReturnValue({ toArray: mockToArray });
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
  useColumnSchemas,
  useCurrentQuery,
  usePreference,
  useRunningQueries,
  useTabs,
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
