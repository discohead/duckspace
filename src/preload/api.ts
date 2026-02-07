import type {
  QueryHandle,
  QueryStatus,
  ArrowBatch,
  CatalogEntry,
  ColumnSchema,
  WorkerHealth,
  AppState,
  QueryHistoryPushRecord,
} from '@shared/types';

export interface QueryNamespace {
  execute(sql: string, params?: unknown[]): Promise<QueryHandle>;
  cancel(queryId: string): Promise<void>;
  onStatus(callback: (status: QueryStatus) => void): () => void;
  onData(queryId: string, callback: (batch: ArrowBatch) => void): () => void;
  onQueryHistory(callback: (record: QueryHistoryPushRecord) => void): () => void;
}

export interface CatalogNamespace {
  listTables(): Promise<CatalogEntry[]>;
  describeTable(tableName: string): Promise<ColumnSchema[]>;
  previewTable(tableName: string, limit?: number): Promise<QueryHandle>;
}

export interface LifecycleNamespace {
  ready(): Promise<void>;
  getAppState(): Promise<AppState>;
  shutdownAck(): Promise<void>;
  onWorkerHealth(callback: (health: WorkerHealth) => void): () => void;
  onShutdownPrepare(callback: () => void): () => void;
  onBoundsChanged(callback: (bounds: { x: number; y: number; width: number; height: number }) => void): () => void;
}

export interface DatspaceAPI {
  query: QueryNamespace;
  catalog: CatalogNamespace;
  lifecycle: LifecycleNamespace;
}
