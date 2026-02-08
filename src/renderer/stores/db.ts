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
import Dexie, { type Table } from 'dexie';

/**
 * Dexie.js database for the renderer process.
 * Defines 9 IndexedDB tables for tabs, queries, catalog, preferences, worker health,
 * recovery logs, and general app state. Schema indexes are declared in the constructor.
 */
export class DatspaceDB extends Dexie {
  declare tabs: Table<Tab, string>;
  declare queries: Table<Query, string>;
  declare catalog_entries: Table<CatalogEntry, string>;
  declare column_schemas: Table<ColumnSchemaRecord, string>;
  declare query_history: Table<QueryHistoryRecord, string>;
  declare preferences: Table<Preference, string>;
  declare worker_health: Table<WorkerHealthRecord, string>;
  declare recovery_log: Table<RecoveryLogEntry, string>;
  declare app_state: Table<AppStateEntry, string>;

  constructor() {
    super('Datspace');

    this.version(1).stores({
      tabs: 'id, type, order',
      queries: 'id, tabId, status, startedAt',
      catalog_entries: 'id, name, type, status, registeredAt',
      column_schemas: 'id, catalogEntryId, [catalogEntryId+columnName]',
      query_history: 'id, timestamp, *tags',
      preferences: 'id',
      worker_health: 'id',
      recovery_log: 'id, timestamp',
      app_state: 'id',
    });
  }
}

/** Singleton Dexie.js database instance used throughout the renderer process. */
export const db = new DatspaceDB();
