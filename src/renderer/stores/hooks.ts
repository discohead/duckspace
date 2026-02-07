import { useLiveQuery } from 'dexie-react-hooks';
import db from './db';
import type {
  Tab,
  Query,
  WorkerHealthRecord,
  Preference,
  AppStateEntry,
  CatalogEntry,
  ColumnSchemaRecord,
} from '@shared/types';

/** Returns all tabs ordered by display position. */
export function useTabs(): Tab[] | undefined {
  return useLiveQuery(() => db.tabs.orderBy('order').toArray());
}

/** Returns the currently active tab. */
export function useActiveTab(): Tab | undefined {
  return useLiveQuery(() => db.tabs.filter((tab) => tab.active).first());
}

/** Returns the DuckDB worker health record. */
export function useWorkerHealth(): WorkerHealthRecord | undefined {
  return useLiveQuery(() => db.worker_health.get('duckdb'));
}

/** Returns a preference value by key, falling back to defaultValue if not found. */
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

/** Returns an app_state value by key. */
export function useAppState<T>(key: string): T | undefined {
  return useLiveQuery(
    async () => {
      const entry: AppStateEntry | undefined = await db.app_state.get(key);
      return entry ? (entry.value as T) : undefined;
    },
    [key],
  );
}

/** Returns all queries with status 'running'. */
export function useRunningQueries(): Query[] | undefined {
  return useLiveQuery(() =>
    db.queries.where('status').equals('running').toArray(),
  );
}

/** Returns the most recent query for a given tab (sorted by startedAt descending). */
export function useCurrentQuery(tabId: string): Query | undefined {
  return useLiveQuery(
    () =>
      db.queries
        .where('tabId')
        .equals(tabId)
        .reverse()
        .sortBy('startedAt')
        .then((queries) => queries[0]),
    [tabId],
  );
}

/** Returns all active catalog entries sorted by name. */
export function useCatalogEntries(): CatalogEntry[] | undefined {
  return useLiveQuery(() =>
    db.catalog_entries
      .where('status')
      .equals('active')
      .sortBy('name'),
  );
}

/** Returns column schemas for a catalog entry, sorted by ordinal position. */
export function useColumnSchemas(
  catalogEntryId: string,
): ColumnSchemaRecord[] | undefined {
  return useLiveQuery(
    () =>
      db.column_schemas
        .where('catalogEntryId')
        .equals(catalogEntryId)
        .sortBy('ordinalPosition'),
    [catalogEntryId],
  );
}
