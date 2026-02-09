import type {
  AppStateEntry,
  CatalogEntry,
  ColumnSchemaRecord,
  ColumnStatisticsRecord,
  DataSource,
  IngestionJob,
  Preference,
  Query,
  Tab,
  WatchDirectory,
  WorkerHealthRecord,
} from '@shared/types';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from './db';

/**
 * Returns all tabs ordered by display position.
 * Reactively updates when tabs are added, removed, or reordered in Dexie.js.
 *
 * @returns An array of tabs sorted by `order`, or `undefined` while loading.
 */
export function useTabs(): Tab[] | undefined {
  return useLiveQuery(() => db.tabs.orderBy('order').toArray());
}

/**
 * Returns the currently active tab (the one with `active === true`).
 *
 * @returns The active tab, or `undefined` if none is active or still loading.
 */
export function useActiveTab(): Tab | undefined {
  return useLiveQuery(() => db.tabs.filter((tab: Tab) => tab.active).first());
}

/**
 * Returns the DuckDB worker health record for status indicators.
 *
 * @returns The worker health record, or `undefined` while loading.
 */
export function useWorkerHealth(): WorkerHealthRecord | undefined {
  return useLiveQuery(() => db.worker_health.get('duckdb'));
}

/**
 * Returns a preference value by key, falling back to a default if not found.
 *
 * @param key - The preference key to look up.
 * @param defaultValue - The fallback value when the preference does not exist.
 * @returns The stored preference value cast to `T`, or `defaultValue`.
 */
export function usePreference<T>(key: string, defaultValue: T): T {
  return (
    useLiveQuery(
      async () => {
        const pref: Preference | undefined = await db.preferences.get(key);
        return pref ? (pref.value as T) : defaultValue;
      },
      [key],
      defaultValue,
    ) ?? defaultValue
  );
}

/**
 * Returns a typed value from the `app_state` table by key.
 *
 * @param key - The app state key to look up.
 * @returns The stored value cast to `T`, or `undefined` if not found.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- intentional: callers specify T for type-safe casting
export function useAppState<T>(key: string): T | undefined {
  return useLiveQuery(async () => {
    const entry: AppStateEntry | undefined = await db.app_state.get(key);
    return entry ? (entry.value as T) : undefined;
  }, [key]);
}

/**
 * Returns all queries currently in the `running` state.
 *
 * @returns An array of running queries, or `undefined` while loading.
 */
export function useRunningQueries(): Query[] | undefined {
  return useLiveQuery(() => db.queries.where('status').equals('running').toArray());
}

/**
 * Returns the most recent query for a given tab, sorted by `startedAt` descending.
 *
 * @param tabId - The tab ID to filter queries by.
 * @returns The most recent query for the tab, or `undefined` if none exists.
 */
export function useCurrentQuery(tabId: string): Query | undefined {
  return useLiveQuery(
    () =>
      db.queries
        .where('tabId')
        .equals(tabId)
        .reverse()
        .sortBy('startedAt')
        .then((queries: Query[]) => queries[0]),
    [tabId],
  );
}

/**
 * Returns all catalog entries with `status === 'active'`, sorted alphabetically by name.
 *
 * @returns An array of active catalog entries, or `undefined` while loading.
 */
export function useCatalogEntries(): CatalogEntry[] | undefined {
  return useLiveQuery(() => db.catalog_entries.where('status').equals('active').sortBy('name'));
}

/**
 * Returns column schemas for a catalog entry, sorted by ordinal position.
 *
 * @param catalogEntryId - The catalog entry ID to fetch column schemas for.
 * @returns An array of column schema records, or `undefined` while loading.
 */
export function useColumnSchemas(catalogEntryId: string): ColumnSchemaRecord[] | undefined {
  return useLiveQuery(
    () =>
      db.column_schemas.where('catalogEntryId').equals(catalogEntryId).sortBy('ordinalPosition'),
    [catalogEntryId],
  );
}

/**
 * Returns data sources from the catalog with optional filters.
 * Reactively updates when data sources change in Dexie.js.
 *
 * @param filters - Optional filters for status, format, or tags.
 * @returns An array of DataSource records, or undefined while loading.
 */
export function useCatalogSources(filters?: {
  readonly status?: DataSource['status'];
  readonly format?: DataSource['format'];
}): DataSource[] | undefined {
  return useLiveQuery(async () => {
    let collection = db.data_sources.toCollection();
    if (filters?.status) {
      collection = db.data_sources.where('status').equals(filters.status);
    }
    const results = await collection.sortBy('createdAt');
    if (filters?.format) {
      return results.filter((s: DataSource) => s.format === filters.format);
    }
    return results;
  }, [filters?.status, filters?.format]);
}

/**
 * Returns ingestion jobs with optional status filter.
 * Reactively updates when jobs change in Dexie.js.
 *
 * @param statusFilter - Optional filter for job status.
 * @returns An array of IngestionJob records, or undefined while loading.
 */
export function useIngestionJobs(
  statusFilter?: IngestionJob['status'],
): IngestionJob[] | undefined {
  return useLiveQuery(async () => {
    if (statusFilter) {
      return db.ingestion_jobs.where('status').equals(statusFilter).reverse().sortBy('startedAt');
    }
    return db.ingestion_jobs.orderBy('startedAt').reverse().toArray();
  }, [statusFilter]);
}

/**
 * Returns column statistics for a data source, sorted by column name.
 * Reactively updates when statistics are computed or updated in Dexie.js.
 *
 * @param dataSourceId - The data source to fetch statistics for.
 * @returns An array of ColumnStatisticsRecord, or undefined while loading.
 */
export function useColumnStats(
  dataSourceId: string | undefined,
): ColumnStatisticsRecord[] | undefined {
  return useLiveQuery(async () => {
    if (!dataSourceId) return [];
    return db.column_statistics.where('dataSourceId').equals(dataSourceId).toArray();
  }, [dataSourceId]);
}

/**
 * Returns a single data source by ID.
 * Reactively updates when the data source changes in Dexie.js.
 *
 * @param dataSourceId - The data source ID to look up.
 * @returns The DataSource record, or undefined if not found or still loading.
 */
export function useDataSource(dataSourceId: string | undefined): DataSource | undefined {
  return useLiveQuery(async () => {
    if (!dataSourceId) return undefined;
    return db.data_sources.get(dataSourceId);
  }, [dataSourceId]);
}

/**
 * Returns watch directories from the Dexie store with optional active-only filter.
 * Reactively updates when watch directories change in Dexie.js.
 *
 * @param activeOnly - If true, only returns directories with isActive === true.
 * @returns An array of WatchDirectory records, or undefined while loading.
 */
export function useWatchDirectories(activeOnly?: boolean): WatchDirectory[] | undefined {
  return useLiveQuery(async () => {
    if (activeOnly) {
      return db.watch_directories.where('isActive').equals(1).sortBy('createdAt');
    }
    return db.watch_directories.orderBy('createdAt').toArray();
  }, [activeOnly]);
}
