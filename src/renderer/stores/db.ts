import Dexie, { type Table } from 'dexie';
import type {
  Tab,
  Query,
  CatalogEntry,
  ColumnSchemaRecord,
  QueryHistoryRecord,
  Preference,
  WorkerHealthRecord,
  RecoveryLogEntry,
  AppStateEntry,
} from '@shared/types';

export class DatspaceDB extends Dexie {
  tabs!: Table<Tab, string>;
  queries!: Table<Query, string>;
  catalog_entries!: Table<CatalogEntry, string>;
  column_schemas!: Table<ColumnSchemaRecord, string>;
  query_history!: Table<QueryHistoryRecord, string>;
  preferences!: Table<Preference, string>;
  worker_health!: Table<WorkerHealthRecord, string>;
  recovery_log!: Table<RecoveryLogEntry, string>;
  app_state!: Table<AppStateEntry, string>;

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

const db = new DatspaceDB();
export default db;
