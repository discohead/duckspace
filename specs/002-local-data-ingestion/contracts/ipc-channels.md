# IPC Channel Contracts: Local Data Ingestion

**Feature**: 002-local-data-ingestion
**Date**: 2026-02-07

All new IPC channels follow the existing `ipcMain.handle` / `ipcRenderer.invoke` pattern. Request/response types are validated by Zod schemas with `.strict()`.

---

## New IPC Channels

### Channel: `ingestion:importFiles`

**Direction**: Renderer → Main → Worker
**Purpose**: Import one or more local files into DuckDB and register in the catalog.

```typescript
/** Request */
interface ImportFilesRequest {
  readonly type: 'ingestion:importFiles';
  readonly filePaths: readonly string[];        // Absolute paths to files
  readonly trigger: IngestionTrigger;            // 'file_picker' | 'drag_and_drop' | 'watch_directory' | 'retry'
}

/** Response */
interface ImportFilesResponse {
  readonly type: 'ingestion:importFiles:response';
  readonly jobs: readonly {
    readonly jobId: string;          // IngestionJob.id
    readonly dataSourceId: string;   // DataSource.id
    readonly filePath: string;
    readonly format: DataSourceFormat;
  }[];
}
```

**Error codes**: `E2001` (file not found), `E2002` (unsupported format), `E2003` (permission denied)

---

### Channel: `ingestion:cancelJob`

**Direction**: Renderer → Main → Worker
**Purpose**: Cancel an in-progress ingestion job.

```typescript
/** Request */
interface CancelJobRequest {
  readonly type: 'ingestion:cancelJob';
  readonly jobId: string;
}

/** Response */
interface CancelJobResponse {
  readonly type: 'ingestion:cancelJob:response';
  readonly jobId: string;
  readonly cancelled: boolean;     // false if job was already completed/failed
}
```

---

### Channel: `ingestion:getProgress`

**Direction**: Renderer → Main
**Purpose**: Get current progress for an active ingestion job.

```typescript
/** Request */
interface GetProgressRequest {
  readonly type: 'ingestion:getProgress';
  readonly jobId: string;
}

/** Response */
interface GetProgressResponse {
  readonly type: 'ingestion:getProgress:response';
  readonly jobId: string;
  readonly status: IngestionJobStatus;
  readonly rowsProcessed: number;
  readonly bytesProcessed: number;
  readonly estimatedTotalRows: number | undefined;
  readonly durationMs: number;
  readonly errorMessage: string | undefined;
}
```

---

### Channel: `catalog:getSources`

**Direction**: Renderer → Main
**Purpose**: List all data sources in the catalog with status and metadata.

```typescript
/** Request */
interface GetSourcesRequest {
  readonly type: 'catalog:getSources';
  readonly filters?: {
    readonly status?: readonly DataSourceStatus[];
    readonly format?: readonly DataSourceFormat[];
    readonly tags?: readonly string[];
  };
}

/** Response */
interface GetSourcesResponse {
  readonly type: 'catalog:getSources:response';
  readonly sources: readonly DataSource[];
}
```

---

### Channel: `catalog:removeSource`

**Direction**: Renderer → Main → Worker
**Purpose**: Remove a data source from the catalog and drop its DuckDB table.

```typescript
/** Request */
interface RemoveSourceRequest {
  readonly type: 'catalog:removeSource';
  readonly dataSourceId: string;
}

/** Response */
interface RemoveSourceResponse {
  readonly type: 'catalog:removeSource:response';
  readonly dataSourceId: string;
  readonly tableName: string;      // DuckDB table that was dropped
  readonly success: boolean;
}
```

**Error codes**: `E2010` (source not found), `E2011` (table drop failed)

---

### Channel: `catalog:updateSource`

**Direction**: Renderer → Main
**Purpose**: Update data source metadata (name, tags).

```typescript
/** Request */
interface UpdateSourceRequest {
  readonly type: 'catalog:updateSource';
  readonly dataSourceId: string;
  readonly updates: {
    readonly name?: string;
    readonly tags?: readonly string[];
  };
}

/** Response */
interface UpdateSourceResponse {
  readonly type: 'catalog:updateSource:response';
  readonly dataSourceId: string;
  readonly source: DataSource;
}
```

---

### Channel: `catalog:getColumnStats`

**Direction**: Renderer → Main → Worker
**Purpose**: Compute or retrieve column statistics for a data source.

```typescript
/** Request */
interface GetColumnStatsRequest {
  readonly type: 'catalog:getColumnStats';
  readonly dataSourceId: string;
  readonly forceRecompute?: boolean;  // Ignore cached stats
}

/** Response */
interface GetColumnStatsResponse {
  readonly type: 'catalog:getColumnStats:response';
  readonly dataSourceId: string;
  readonly columns: readonly ColumnStatistics[];
  readonly computedAt: string;     // ISO 8601
  readonly durationMs: number;
}
```

---

### Channel: `watch:addDirectory`

**Direction**: Renderer → Main
**Purpose**: Configure a new watch directory for automatic file ingestion.

```typescript
/** Request */
interface AddWatchDirectoryRequest {
  readonly type: 'watch:addDirectory';
  readonly path: string;
  readonly options?: {
    readonly recursive?: boolean;           // Default: true
    readonly fileTypeFilter?: readonly DataSourceFormat[];
    readonly excludePatterns?: readonly string[];
    readonly autoReingest?: boolean;        // Default: false
    readonly stabilityThresholdMs?: number; // Default: 2000
  };
}

/** Response */
interface AddWatchDirectoryResponse {
  readonly type: 'watch:addDirectory:response';
  readonly watchDirectory: WatchDirectory;
}
```

**Error codes**: `E2020` (directory not found), `E2021` (not a directory), `E2022` (permission denied), `E2023` (already watching)

---

### Channel: `watch:removeDirectory`

**Direction**: Renderer → Main
**Purpose**: Stop watching a directory and optionally remove associated sources.

```typescript
/** Request */
interface RemoveWatchDirectoryRequest {
  readonly type: 'watch:removeDirectory';
  readonly watchDirectoryId: string;
  readonly removeAssociatedSources?: boolean; // Default: false
}

/** Response */
interface RemoveWatchDirectoryResponse {
  readonly type: 'watch:removeDirectory:response';
  readonly watchDirectoryId: string;
  readonly sourcesRemoved: number;   // 0 if removeAssociatedSources was false
}
```

---

### Channel: `watch:listDirectories`

**Direction**: Renderer → Main
**Purpose**: List all configured watch directories.

```typescript
/** Response */
interface ListWatchDirectoriesResponse {
  readonly type: 'watch:listDirectories:response';
  readonly directories: readonly WatchDirectory[];
}
```

---

## Push Events (webContents.send)

### Event: `ingestion:progress`

**Direction**: Main → Renderer
**Purpose**: Real-time progress updates for active ingestion jobs.

```typescript
interface IngestionProgressEvent {
  readonly type: 'ingestion:progress';
  readonly jobId: string;
  readonly dataSourceId: string;
  readonly status: IngestionJobStatus;
  readonly rowsProcessed: number;
  readonly bytesProcessed: number;
  readonly estimatedTotalRows: number | undefined;
  readonly durationMs: number;
}
```

### Event: `ingestion:complete`

**Direction**: Main → Renderer
**Purpose**: Notification when an ingestion job completes (success or failure).

```typescript
interface IngestionCompleteEvent {
  readonly type: 'ingestion:complete';
  readonly jobId: string;
  readonly dataSourceId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly rowCount: number | undefined;
  readonly columnCount: number | undefined;
  readonly durationMs: number;
  readonly errorMessage: string | undefined;
  readonly errorCode: string | undefined;
}
```

### Event: `watch:fileEvent`

**Direction**: Main → Renderer
**Purpose**: Notification when a watched file is added, modified, or deleted.

```typescript
interface WatchFileEvent {
  readonly type: 'watch:fileEvent';
  readonly watchDirectoryId: string;
  readonly eventType: 'add' | 'change' | 'unlink';
  readonly filePath: string;
  readonly format: DataSourceFormat | undefined;  // undefined for unlink
}
```

### Event: `catalog:sourceUpdated`

**Direction**: Main → Renderer
**Purpose**: Notification when a data source status changes (from file watcher or ingestion).

```typescript
interface CatalogSourceUpdatedEvent {
  readonly type: 'catalog:sourceUpdated';
  readonly dataSourceId: string;
  readonly status: DataSourceStatus;
  readonly previousStatus: DataSourceStatus;
}
```

---

## Constants Additions (src/shared/constants.ts)

```typescript
// New IPC Channels
export const IPC_CHANNELS = {
  // ... existing channels ...

  // Ingestion
  INGESTION_IMPORT_FILES: 'ingestion:importFiles',
  INGESTION_CANCEL_JOB: 'ingestion:cancelJob',
  INGESTION_GET_PROGRESS: 'ingestion:getProgress',

  // Catalog (extended)
  CATALOG_GET_SOURCES: 'catalog:getSources',
  CATALOG_REMOVE_SOURCE: 'catalog:removeSource',
  CATALOG_UPDATE_SOURCE: 'catalog:updateSource',
  CATALOG_GET_COLUMN_STATS: 'catalog:getColumnStats',

  // Watch directories
  WATCH_ADD_DIRECTORY: 'watch:addDirectory',
  WATCH_REMOVE_DIRECTORY: 'watch:removeDirectory',
  WATCH_LIST_DIRECTORIES: 'watch:listDirectories',
} as const;

// New Push Events
export const PUSH_EVENTS = {
  // ... existing events ...
  INGESTION_PROGRESS: 'ingestion:progress',
  INGESTION_COMPLETE: 'ingestion:complete',
  WATCH_FILE_EVENT: 'watch:fileEvent',
  CATALOG_SOURCE_UPDATED: 'catalog:sourceUpdated',
} as const;
```
