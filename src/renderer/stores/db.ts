import type {
  AppStateEntry,
  CatalogEntry,
  ColumnSchemaRecord,
  ColumnStatisticsRecord,
  DataSource,
  IngestionJob,
  Preference,
  Query,
  QueryHistoryRecord,
  RecoveryLogEntry,
  Tab,
  WatchDirectory,
  WorkerHealthRecord,
} from '@shared/types';
import Dexie, { type Table } from 'dexie';

/**
 * Dexie.js database for the renderer process.
 * Defines 13 IndexedDB tables for tabs, queries, catalog, data sources, ingestion jobs,
 * watch directories, column statistics, preferences, worker health, recovery logs, and app state.
 * Schema indexes are declared in the constructor.
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
  declare data_sources: Table<DataSource, string>;
  declare ingestion_jobs: Table<IngestionJob, string>;
  declare watch_directories: Table<WatchDirectory, string>;
  declare column_statistics: Table<ColumnStatisticsRecord, string>;

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

    this.version(2).stores({
      tabs: 'id, type, order',
      queries: 'id, tabId, status, startedAt',
      catalog_entries: 'id, name, type, status, registeredAt',
      column_schemas: 'id, catalogEntryId, [catalogEntryId+columnName]',
      query_history: 'id, timestamp, *tags',
      preferences: 'id',
      worker_health: 'id',
      recovery_log: 'id, timestamp',
      app_state: 'id',
      data_sources: 'id, name, format, status, filePath, createdAt, *tags',
      ingestion_jobs: 'id, dataSourceId, status, startedAt',
      watch_directories: 'id, path, isActive',
      column_statistics: 'id, dataSourceId, [dataSourceId+columnName]',
    });
  }
}

/** Singleton Dexie.js database instance used throughout the renderer process. */
export const db = new DatspaceDB();
