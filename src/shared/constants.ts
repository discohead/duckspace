/**
 * Shared constants for the Datspace Electron application.
 *
 * IPC channel names, push events, timeouts, backpressure config,
 * health-check config, default configuration values, and app metadata.
 */

import type { DatspaceConfig } from './types';

// ---------------------------------------------------------------------------
// 1. IPC Channel Names (ipcMain.handle / ipcRenderer.invoke)
// ---------------------------------------------------------------------------

export const IPC_CHANNELS = {
  QUERY_EXECUTE: 'query:execute',
  QUERY_CANCEL: 'query:cancel',
  QUERY_LIST_TABLES: 'query:listTables',
  QUERY_DESCRIBE_TABLE: 'query:describeTable',
  CATALOG_PREVIEW: 'catalog:preview',
  LIFECYCLE_READY: 'lifecycle:ready',
  LIFECYCLE_GET_APP_STATE: 'lifecycle:getAppState',
  LIFECYCLE_SHUTDOWN_ACK: 'lifecycle:shutdownAck',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_ALL: 'config:getAll',
} as const;

// ---------------------------------------------------------------------------
// 2. Push Event Names (webContents.send / ipcRenderer.on)
// ---------------------------------------------------------------------------

export const PUSH_EVENTS = {
  QUERY_PROGRESS: 'query:progress',
  QUERY_HISTORY: 'query:history',
  WORKER_STATUS: 'worker:status',
  SHUTDOWN_PREPARE: 'shutdown-prepare',
  WINDOW_BOUNDS_CHANGED: 'window:bounds-changed',
  PORT: 'port',
} as const;

// ---------------------------------------------------------------------------
// 3. Data Plane Channel Names
// ---------------------------------------------------------------------------

export const DATA_CHANNELS = {
  DUCKDB_DATA: 'duckdb-data',
} as const;

// ---------------------------------------------------------------------------
// 4. Timeout Values (milliseconds)
// ---------------------------------------------------------------------------

export const TIMEOUTS = {
  IPC_DEFAULT: 30_000,
  IPC_MAX: 120_000,
  WORKER_COMMAND: 30_000,
  WORKER_COMMAND_MAX: 60_000,
  BATCH_ACK: 10_000,
  BATCH_ACK_MAX: 60_000,
  HEARTBEAT: 5_000,
  SHUTDOWN_ACK: 5_000,
  SHUTDOWN_TOTAL: 6_000,
  QUERY_DEFAULT: 30_000,
} as const;

// ---------------------------------------------------------------------------
// 5. Backpressure Configuration
// ---------------------------------------------------------------------------

export const BACKPRESSURE = {
  WINDOW_SIZE: 4,
  TARGET_BATCH_SIZE_BYTES: 2 * 1024 * 1024, // ~2 MB
  MAX_INFLIGHT_BYTES: 8 * 1024 * 1024, // ~8 MB
  ACK_TIMEOUT_MS: 10_000,
} as const;

// ---------------------------------------------------------------------------
// 6. Health Check Configuration
// ---------------------------------------------------------------------------

export const HEALTH_CHECK = {
  INTERVAL_MS: 60_000,
  HEARTBEAT_TIMEOUT_MS: 5_000,
  MAX_CONSECUTIVE_MISSES: 2,
  MAX_RESTART_ATTEMPTS: 3,
} as const;

// ---------------------------------------------------------------------------
// 7. Default Config Values
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: DatspaceConfig = {
  duckdb: {
    memoryLimitPercent: 50,
    memoryLimitOverrideMB: null,
    threads: null,
    extensions: ['parquet', 'json', 'icu'],
  },
  paths: {
    database: 'analytics.duckdb',
    tempDir: 'tmp',
    config: 'config.json',
  },
  workers: {
    healthCheckIntervalMs: 60_000,
    heartbeatTimeoutMs: 5_000,
    maxRestartAttempts: 3,
    v8HeapLimitMB: 512,
  },
  ui: {
    theme: 'system',
    fontSize: 14,
    defaultQueryLimit: 1_000,
  },
  lifecycle: {
    shutdownTimeoutMs: 6_000,
    walCheckpointOnShutdown: true,
  },
};

// ---------------------------------------------------------------------------
// 8. Default Preferences (Dexie.js seeding)
// ---------------------------------------------------------------------------

export const DEFAULT_PREFERENCES = [
  { id: 'appearance.theme', value: 'system', category: 'appearance' },
  { id: 'appearance.fontSize', value: 14, category: 'appearance' },
  { id: 'editor.defaultLimit', value: 1_000, category: 'editor' },
  { id: 'editor.autoComplete', value: true, category: 'editor' },
  { id: 'editor.tabSize', value: 2, category: 'editor' },
  { id: 'memory.duckdbLimitPct', value: 50, category: 'memory' },
] as const;

// ---------------------------------------------------------------------------
// 9. Worker V8 Heap Limit
// ---------------------------------------------------------------------------

export const WORKER_V8_HEAP_LIMIT_MB = 512;

// ---------------------------------------------------------------------------
// 10. App Metadata
// ---------------------------------------------------------------------------

export const APP_NAME = 'Datspace';
export const DEXIE_DB_NAME = 'Datspace';
export const DEXIE_SCHEMA_VERSION = 1;
