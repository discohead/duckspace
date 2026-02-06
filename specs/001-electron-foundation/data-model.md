# Data Model: Electron Foundation (Phase 1)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)
**Date**: 2026-02-05

---

## Overview

Phase 1 uses three data stores, each scoped to its process boundary:

1. **DuckDB** (Worker Thread #1) -- the analytical SQL engine. Stores registered tables, views, and query history in a single database file at `~/Library/Application Support/Datspace/analytics.duckdb`. All query results flow out as Arrow IPC buffers; no analytical data is persisted in the Renderer.

2. **Dexie.js** (Renderer Process, IndexedDB) -- reactive UI state. Manages 9 collections covering tab state, query metadata, catalog entries, column schemas, query history (UI mirror), user preferences, worker health status, crash recovery log, and application-level state. All writes are local to the Renderer; the Main Process pushes updates via `webContents.send()` through the CatalogSyncBridge.

3. **JSON Configuration** -- a plain `config.json` file at `~/Library/Application Support/Datspace/config.json`. Stores machine-specific settings (memory limits, thread counts) that must be read before any database initializes.

Phase 1 does **not** include LanceDB, vector search, embeddings, remote connectors, dashboards, or AI chat. Those entities exist in the full data model spec but are deferred to later phases. The Dexie.js schema is declared at version 1 with all 9 Phase 1 collections; future phases add collections via Dexie.js version increments.

---

## DuckDB (Worker Thread #1)

**File**: `~/Library/Application Support/Datspace/analytics.duckdb`
**Process**: Main Process, delegated to Worker Thread #1 via `@duckdb/node-api` (Neo client)
**Architecture Reference**: [04-database-integration.md, Section 2](../../context/artifacts/design/04-database-integration.md)

### Configuration

| Parameter | Default | Source | Effect |
|-----------|---------|--------|--------|
| `memory_limit` | 50% of system RAM (e.g., `"8GB"` on 16 GB Mac) | `config.json` | DuckDB spills to disk when limit is reached |
| `threads` | `os.cpus().length - 2` | `config.json` | DuckDB internal thread pool size |
| `temp_directory` | `~/Library/Application Support/Datspace/tmp/` | Derived from app data path | Spill-to-disk location for large intermediate results |
| `access_mode` | `READ_WRITE` | Fixed | MVCC: multiple concurrent readers, single writer |

DuckDB extensions loaded at startup: `parquet`, `json`, `httpfs`, `icu`. Extensions are bundled in `resources/duckdb-extensions/` and pinned to the DuckDB version.

### System Catalog (information_schema)

Phase 1 uses DuckDB's built-in `information_schema` views for schema browsing. No custom catalog table is needed -- the DuckDB Worker queries these views on demand and pushes results to the Renderer via the CatalogSyncBridge.

**Primary catalog query:**

```sql
SELECT
  table_name AS name,
  table_schema AS schema,
  CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type,
  estimated_size AS size_bytes
FROM information_schema.tables
WHERE table_schema = 'main'
  AND table_name NOT LIKE '__%';
```

**Column schema query:**

```sql
SELECT
  column_name,
  data_type,
  is_nullable = 'YES' AS nullable,
  ordinal_position
FROM information_schema.columns
WHERE table_schema = 'main'
  AND table_name = ?
ORDER BY ordinal_position;
```

### Registered Tables

User data registered in DuckDB as persistent tables or views over external files. In Phase 1, these are programmatically pre-registered sample tables for testing (file ingestion is Phase 2).

**Registration patterns (Phase 1):**

- **Sample data**: `CREATE TABLE sample_data AS SELECT * FROM arrow_scan(?)` where the Arrow buffer contains pre-generated test data.
- **Parquet files (direct)**: `CREATE VIEW source_name AS SELECT * FROM read_parquet('path/to/file.parquet')` -- views reference external data without copying.

Each registered table/view is discoverable via `information_schema.tables` and its columns via `information_schema.columns`. The DuckDB Worker reports catalog changes to the Main Process, which relays them to the Renderer for Dexie.js storage.

### Query History Table

Tracks every SQL query executed through DuckDB. Created at first startup.

```sql
CREATE TABLE IF NOT EXISTS _query_history (
  query_id          VARCHAR PRIMARY KEY,
  sql               VARCHAR NOT NULL,
  description       VARCHAR,
  execution_time_ms INTEGER NOT NULL,
  row_count         INTEGER NOT NULL DEFAULT 0,
  timestamp         TIMESTAMP NOT NULL DEFAULT current_timestamp,
  source            VARCHAR NOT NULL DEFAULT 'user',
  tags              VARCHAR[] DEFAULT '{}',
  status            VARCHAR NOT NULL DEFAULT 'success',
  error_message     VARCHAR
);

CREATE INDEX IF NOT EXISTS idx_qh_timestamp
  ON _query_history (timestamp DESC);
```

| Column | Type | Constraint | Default | Description |
|--------|------|-----------|---------|-------------|
| `query_id` | VARCHAR | PRIMARY KEY | Generated UUID | Unique identifier for this execution |
| `sql` | VARCHAR | NOT NULL | -- | The SQL statement executed |
| `description` | VARCHAR | Optional | NULL | Natural language description (future: AI-generated) |
| `execution_time_ms` | INTEGER | NOT NULL | -- | Duration in milliseconds |
| `row_count` | INTEGER | NOT NULL | 0 | Result set row count |
| `timestamp` | TIMESTAMP | NOT NULL | `current_timestamp` | When the query was executed |
| `source` | VARCHAR | NOT NULL | `'user'` | Origin: `'user'`, `'ai'`, or `'system'` |
| `tags` | VARCHAR[] | Optional | `'{}'` | User-assigned tags |
| `status` | VARCHAR | NOT NULL | `'success'` | `'success'` or `'error'` |
| `error_message` | VARCHAR | Optional | NULL | Error details if status is `'error'` |

### Schema Version Tracking

DuckDB schema evolution is tracked via an explicit version table:

```sql
CREATE TABLE IF NOT EXISTS _schema_version (
  version     VARCHAR PRIMARY KEY,
  applied_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
  description VARCHAR
);

-- Phase 1 initial version
INSERT INTO _schema_version (version, description)
VALUES ('1.0.0', 'Phase 1: Electron Foundation - query history and schema version tracking');
```

### Memory and Spill-to-Disk

- DuckDB is configured with `memory_limit` = 50% of system RAM (e.g., 8 GB on a 16 GB Mac, 4 GB on an 8 GB Mac).
- When intermediate query results exceed the memory limit, DuckDB transparently spills to `~/Library/Application Support/Datspace/tmp/`.
- The `tmp/` directory is cleaned on graceful shutdown.
- The V8 heap limit for the Worker Thread is set to 512 MB (`resourceLimits.maxOldGenerationSizeMb`), separate from DuckDB's native memory budget.

---

## Dexie.js (Renderer Process -- IndexedDB)

**Database Name**: `Datspace`
**Storage Location**: `~/Library/Application Support/Datspace/IndexedDB/` (managed by Chromium)
**Schema Version**: 1
**Architecture Reference**: [04-database-integration.md, Section 4](../../context/artifacts/design/04-database-integration.md), [data-model-spec.md, Section 4](../../context/artifacts/data-model/data-model-spec.md)

Phase 1 declares 9 collections. The naming convention below maps between the plan.md shorthand names, the Dexie.js collection names, and the spec entities they represent.

### Complete Schema Declaration

```typescript
import Dexie from 'dexie';

class DatspaceDB extends Dexie {
  tabs!: Dexie.Table<Tab, string>;
  queries!: Dexie.Table<Query, string>;
  catalog_entries!: Dexie.Table<CatalogEntry, string>;
  column_schemas!: Dexie.Table<ColumnSchema, string>;
  query_history!: Dexie.Table<QueryHistoryUI, string>;
  preferences!: Dexie.Table<Preference, string>;
  worker_health!: Dexie.Table<WorkerHealthRecord, string>;
  recovery_log!: Dexie.Table<RecoveryLogEntry, string>;
  app_state!: Dexie.Table<AppStateEntry, string>;

  constructor() {
    super('Datspace');

    this.version(1).stores({
      tabs:             'id, type, order',
      queries:          'id, tabId, status, startedAt',
      catalog_entries:  'id, name, type, status, registeredAt',
      column_schemas:   'id, catalogEntryId, [catalogEntryId+columnName]',
      query_history:    'id, timestamp, *tags',
      preferences:      'id',
      worker_health:    'id',
      recovery_log:     'id, timestamp',
      app_state:        'id',
    });
  }
}

const db = new DatspaceDB();
export default db;
```

---

### Collection: `tabs`

**Spec Entity**: Tab State
**Phase 1 Usage**: Persists open tabs (query editor, catalog browser, settings) across sessions. Restores tab order, active tab, and per-tab content on relaunch.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | UUID |
| `type` | `string` | Yes | Tab content type: `'query'`, `'catalog'`, `'settings'` |
| `order` | `number` | Yes | Display order (0-based index in tab bar) |
| `title` | `string` | No | Tab display title |
| `active` | `boolean` | No | Whether this is the currently active tab |
| `state` | `Record<string, unknown>` | No | Tab-type-specific state (see below) |
| `lastAccessedAt` | `string` | No | ISO timestamp of last interaction |

**Tab state payloads by type:**

| Tab Type | `state` Contents |
|----------|-----------------|
| `'query'` | `{ sql: string, cursorPosition?: number, scrollTop?: number }` |
| `'catalog'` | `{ selectedTable?: string, expandedNodes?: string[] }` |
| `'settings'` | `{ section?: string }` |

---

### Collection: `queries`

**Spec Entity**: Query Session
**Phase 1 Usage**: Tracks the execution lifecycle of each SQL query. One query per tab at a time. Stores execution state, timing, error information, and a reference to the result (results themselves flow as Arrow IPC and are never stored in Dexie.js).

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | UUID for this query execution |
| `tabId` | `string` | Yes | Reference to `tabs.id` |
| `sql` | `string` | No | The SQL statement |
| `status` | `string` | Yes | `'idle'`, `'running'`, `'completed'`, `'failed'`, `'cancelled'` |
| `startedAt` | `string` | Yes | ISO timestamp of execution start |
| `completedAt` | `string` | No | ISO timestamp of completion (if finished) |
| `executionTimeMs` | `number` | No | Duration in milliseconds |
| `rowCount` | `number` | No | Number of rows in the result set |
| `errorMessage` | `string` | No | Human-readable error if status is `'failed'` |
| `errorCode` | `string` | No | Error taxonomy code (E1xxx--E9xxx) |

**Lifecycle:**

```
idle -> running -> completed
                -> failed
                -> cancelled
```

---

### Collection: `catalog_entries`

**Spec Entity**: Table Registration
**Phase 1 Usage**: Mirrors DuckDB's registered tables/views in the Renderer for reactive UI display. The CatalogSyncBridge pushes entries here after table registration. Drives the catalog browser sidebar.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | UUID (matches the source identifier) |
| `name` | `string` | Yes | DuckDB table/view name |
| `schema` | `string` | No | DuckDB schema (always `'main'` in Phase 1) |
| `type` | `string` | Yes | `'table'` or `'view'` |
| `status` | `string` | Yes | `'active'`, `'removed'`, `'error'` |
| `rowCount` | `number` | No | Estimated row count |
| `sizeBytes` | `number` | No | Estimated storage size in bytes |
| `columnCount` | `number` | No | Number of columns |
| `registeredAt` | `string` | Yes | ISO timestamp of registration |
| `lastAccessedAt` | `string` | No | ISO timestamp of last query against this table |

---

### Collection: `column_schemas`

**Spec Entity**: Table Registration (column detail)
**Phase 1 Usage**: Stores per-column metadata for each catalog entry. Drives the column list in the catalog browser detail panel and provides type information for the query editor.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | Composite: `{catalogEntryId}_{columnName}` |
| `catalogEntryId` | `string` | Yes | Reference to `catalog_entries.id` |
| `columnName` | `string` | Compound | Column name in DuckDB |
| `columnType` | `string` | No | DuckDB type (e.g., `VARCHAR`, `INTEGER`, `TIMESTAMP`) |
| `arrowType` | `string` | No | Arrow type equivalent (e.g., `Utf8`, `Int32`, `Float64`) |
| `nullable` | `boolean` | No | Whether column allows NULL |
| `ordinalPosition` | `number` | No | Column order in the table |

**Indexes:**

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Direct lookup |
| `catalogEntryId` | Simple | All columns for a catalog entry |
| `[catalogEntryId+columnName]` | Compound | Unique column within a table |

---

### Collection: `query_history`

**Spec Entity**: Query Session (historical record)
**Phase 1 Usage**: UI-side mirror of DuckDB's `_query_history` table, enabling reactive display of query history with `useLiveQuery()`. Synced from the Main Process via CatalogSyncBridge after each query execution.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | Matches `_query_history.query_id` in DuckDB |
| `sql` | `string` | No | The SQL statement |
| `executionTimeMs` | `number` | No | Duration in milliseconds |
| `rowCount` | `number` | No | Result set row count |
| `timestamp` | `string` | Yes | ISO timestamp of execution |
| `source` | `string` | No | `'user'` or `'system'` |
| `tags` | `string[]` | Multi-entry (`*tags`) | User-assigned tags |
| `status` | `string` | No | `'success'` or `'error'` |
| `errorMessage` | `string` | No | Error details if applicable |

---

### Collection: `preferences`

**Spec Entity**: Application Configuration (UI-side subset)
**Phase 1 Usage**: Stores user preferences that the Renderer needs reactively -- theme, font size, editor settings. Machine-level configuration (memory limits, thread counts) lives in `config.json`; Dexie.js preferences cover UI-layer settings.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | Dot-notated key (e.g., `'appearance.theme'`, `'editor.fontSize'`, `'editor.defaultLimit'`) |
| `value` | `unknown` | No | Setting value (type depends on the key) |
| `category` | `string` | No | Grouping: `'appearance'`, `'editor'`, `'memory'`, `'advanced'` |
| `updatedAt` | `string` | No | ISO timestamp of last change |

**Phase 1 default preferences:**

| Key | Default Value | Category | Description |
|-----|--------------|----------|-------------|
| `appearance.theme` | `'system'` | appearance | `'light'`, `'dark'`, or `'system'` |
| `appearance.fontSize` | `14` | appearance | Base font size in pixels |
| `editor.defaultLimit` | `1000` | editor | Default `LIMIT` for unbound queries |
| `editor.autoComplete` | `true` | editor | Enable SQL autocomplete |
| `editor.tabSize` | `2` | editor | Tab width in the SQL editor |
| `memory.duckdbLimitPct` | `50` | memory | DuckDB memory as % of system RAM |

---

### Collection: `worker_health`

**Spec Entity**: Worker Health Record
**Phase 1 Usage**: Tracks the health status of each background worker process. Updated by the WorkerManager via CatalogSyncBridge on every health check cycle (every 60 seconds) and on status transitions. Drives the StatusBar health indicator.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | Worker identifier: `'duckdb'` (Phase 1 has one worker) |
| `status` | `string` | No | `'ready'`, `'busy'`, `'degraded'`, `'restarting'`, `'failed'` |
| `restartCount` | `number` | No | Number of automatic restarts since app launch |
| `lastHeartbeatAt` | `string` | No | ISO timestamp of last successful heartbeat |
| `lastErrorMessage` | `string` | No | Most recent error message (if any) |
| `upSince` | `string` | No | ISO timestamp when the worker last started |
| `activeQueryCount` | `number` | No | Number of queries currently executing |

---

### Collection: `recovery_log`

**Spec Entity**: (Cross-cutting concern for crash recovery)
**Phase 1 Usage**: Records crash detection and recovery actions. Written on startup when an abnormal prior shutdown is detected. Provides an audit trail for the user and for debugging.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | UUID |
| `timestamp` | `string` | Yes | ISO timestamp of detection |
| `type` | `string` | No | `'abnormal_shutdown'`, `'integrity_check'`, `'worker_restart'`, `'wal_recovery'` |
| `details` | `string` | No | Human-readable description of what happened |
| `outcome` | `string` | No | `'recovered'`, `'degraded'`, `'failed'` |
| `affectedWorker` | `string` | No | Worker ID that was affected (if applicable) |

---

### Collection: `app_state`

**Spec Entity**: Application Configuration (runtime state)
**Phase 1 Usage**: Stores singleton application-level state entries that do not fit in other collections. Key examples: last known shutdown status (for crash detection), active session identifier, and window geometry.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `id` | `string` | Primary key | State key (e.g., `'shutdown_status'`, `'window_bounds'`, `'session_id'`) |
| `value` | `unknown` | No | State value |
| `updatedAt` | `string` | No | ISO timestamp of last update |

**Phase 1 state keys:**

| Key | Type | Description |
|-----|------|-------------|
| `shutdown_status` | `'clean' \| 'dirty'` | Set to `'dirty'` on launch, `'clean'` on graceful shutdown. If `'dirty'` on next launch, triggers crash recovery. |
| `window_bounds` | `{ x, y, width, height }` | Window position and size for restore |
| `session_id` | `string` | UUID for the current application session |
| `last_active_tab_id` | `string` | Tab ID to focus on restore |

---

## JSON Configuration

**File**: `~/Library/Application Support/Datspace/config.json`
**Read by**: Main Process (`ConfigManager`) at startup, before database initialization
**Written by**: Main Process on settings changes and on first launch (defaults)

This file stores machine-specific configuration that must be available before Dexie.js or DuckDB initializes. It is read synchronously during early startup.

### Schema

```jsonc
{
  // DuckDB memory and threading
  "duckdb": {
    "memoryLimitPercent": 50,       // % of system RAM (default: 50)
    "memoryLimitOverrideMB": null,  // Explicit MB override (null = use percent)
    "threads": null,                // null = os.cpus().length - 2
    "extensions": [                 // Extensions to load at startup
      "parquet", "json", "httpfs", "icu"
    ]
  },

  // Application paths (derived at runtime, stored for reference)
  "paths": {
    "database": "analytics.duckdb",  // Relative to userData
    "tempDir": "tmp",                // Relative to userData
    "config": "config.json"          // This file (self-reference)
  },

  // Worker health monitoring
  "workers": {
    "healthCheckIntervalMs": 60000,  // How often to ping workers (default: 60s)
    "heartbeatTimeoutMs": 5000,      // Max wait for health check response
    "maxRestartAttempts": 3,         // Auto-restart limit before marking 'failed'
    "v8HeapLimitMB": 512             // V8 heap for worker threads
  },

  // UI preferences (also mirrored in Dexie.js preferences collection)
  "ui": {
    "theme": "system",               // 'light', 'dark', 'system'
    "fontSize": 14,                  // Base font size in pixels
    "defaultQueryLimit": 1000        // Default LIMIT for unbounded SELECTs
  },

  // Lifecycle
  "lifecycle": {
    "shutdownTimeoutMs": 6000,       // Max time for graceful shutdown (SC-009)
    "walCheckpointOnShutdown": true  // Run CHECKPOINT before closing DuckDB
  }
}
```

### Default Generation

On first launch, if `config.json` does not exist, the `ConfigManager` generates it with the defaults above and writes it to disk. Subsequent launches read the file, merge with hardcoded defaults (for any missing keys added in newer versions), and proceed.

### Validation

The `ConfigManager` validates the config against a TypeScript interface on load:

```typescript
interface DatspaceConfig {
  duckdb: {
    memoryLimitPercent: number;       // 10-90
    memoryLimitOverrideMB: number | null;
    threads: number | null;           // null = auto
    extensions: string[];
  };
  paths: {
    database: string;
    tempDir: string;
    config: string;
  };
  workers: {
    healthCheckIntervalMs: number;    // >= 5000
    heartbeatTimeoutMs: number;       // >= 1000
    maxRestartAttempts: number;       // >= 1
    v8HeapLimitMB: number;            // >= 128
  };
  ui: {
    theme: 'light' | 'dark' | 'system';
    fontSize: number;                 // 10-24
    defaultQueryLimit: number;        // >= 0
  };
  lifecycle: {
    shutdownTimeoutMs: number;        // >= 2000
    walCheckpointOnShutdown: boolean;
  };
}
```

---

## Entity Relationships

### Query Session --> `tabs` + `queries`

A **Query Session** (spec entity) spans two Dexie.js collections:

- **`tabs`**: Holds the tab shell -- its type (`'query'`), position in the tab bar, title, and persisted state (SQL text, cursor position, scroll offset).
- **`queries`**: Holds the execution state for the currently active (or most recent) query in that tab -- status, timing, row count, errors.

**Relationship**: One `tab` has zero or many `queries` (linked by `queries.tabId` -> `tabs.id`). At any moment, at most one query per tab is in `'running'` status. When a user executes a new query in a tab, a new `queries` record is created; old records remain in the collection as part of the tab's execution history.

**Data flow**: The user types SQL in the tab (stored in `tabs.state.sql`). On execution, a `queries` entry is created with `status: 'running'`. The DuckDB Worker processes the query and returns results as Arrow IPC via MessagePort. The result data is **never stored** in Dexie.js -- it flows directly to the data grid. Only metadata (row count, execution time, status) is written back to the `queries` collection.

### Table Registration --> `catalog_entries` + `column_schemas`

A **Table Registration** (spec entity) spans two Dexie.js collections:

- **`catalog_entries`**: One record per DuckDB table or view, with summary metadata (name, type, row count, size).
- **`column_schemas`**: One record per column per table, with detailed type information.

**Relationship**: One `catalog_entry` has many `column_schemas` (linked by `column_schemas.catalogEntryId` -> `catalog_entries.id`). The compound index `[catalogEntryId+columnName]` ensures uniqueness.

**Data flow**: When the DuckDB Worker registers a new table, it queries `information_schema.tables` and `information_schema.columns`, packages the results, and sends them to the Main Process. The CatalogSyncBridge formats the data and pushes it to the Renderer, which writes to `catalog_entries` and `column_schemas`. React components subscribed via `useLiveQuery()` re-render automatically.

### Worker Health Record --> `worker_health`

A **Worker Health Record** (spec entity) maps directly to a single `worker_health` collection entry:

- In Phase 1, there is exactly one worker: `id: 'duckdb'`.
- The WorkerManager updates this record on every health check cycle (60-second interval) and on status transitions (e.g., `'ready'` -> `'busy'` -> `'ready'`).

**Data flow**: The Main Process WorkerManager sends heartbeat pings to the DuckDB Worker. On response, it pushes an updated `worker_health` record to the Renderer via CatalogSyncBridge. The StatusBar component subscribes to `worker_health` via `useLiveQuery()` and displays the current status.

### Tab State --> `tabs`

A **Tab State** (spec entity) maps directly to the `tabs` collection. Each open tab in the UI is one record. The `order` field determines tab bar position. The `active` boolean marks the focused tab. The `state` field holds type-specific content that must be restored on relaunch.

**Persistence**: On every meaningful user interaction (typing SQL, switching tabs, scrolling), the tab's `state` is debounced-written to Dexie.js. On graceful shutdown, all tabs are flushed. On next launch, tabs are loaded and restored in order, with the previously active tab focused.

### Application Configuration --> `preferences` + `config.json`

**Application Configuration** (spec entity) is split across two stores:

- **`config.json`**: Machine-level settings read at startup before any database initializes -- DuckDB memory limits, thread counts, worker health intervals, shutdown timeouts. These are not reactive; changes require an application restart to take effect.
- **`preferences`** (Dexie.js): UI-level settings that can change at runtime and must be reactive -- theme, font size, editor preferences. Changes take effect immediately via `useLiveQuery()`.

**Overlap handling**: The `ui` section of `config.json` and certain `preferences` entries overlap intentionally. `config.json` provides the boot-time defaults; Dexie.js `preferences` holds the runtime-current values. If the user changes a preference in the Settings UI, both stores are updated: the Renderer writes to Dexie.js (immediate effect), and sends an IPC message to the Main Process to update `config.json` (persisted for next launch).

---

## Data Lifecycle

### Startup

```
1. Read config.json (sync)
   - Parse and validate configuration
   - Compute DuckDB memory limit from system RAM
   - If config.json missing, generate defaults and write to disk

2. Initialize DuckDB Worker Thread
   - Spawn Worker with config (db path, memory limit, threads, extensions)
   - Worker opens analytics.duckdb (automatic WAL replay if needed)
   - Worker loads extensions
   - Worker creates _query_history and _schema_version tables if missing
   - Worker runs integrity check (PRAGMA integrity_check)
   - Worker reports 'ready' to Main Process

3. Initialize Renderer + Dexie.js
   - BrowserWindow loads renderer HTML
   - Dexie.js opens IndexedDB database 'Datspace' (runs version migrations if needed)
   - liveQuery engine initializes

4. Crash detection
   - Renderer reads app_state['shutdown_status']
   - If 'dirty': abnormal prior shutdown detected
     a. Write recovery_log entry (type: 'abnormal_shutdown')
     b. Request DuckDB integrity verification via IPC
     c. Log outcome to recovery_log
   - Set app_state['shutdown_status'] = 'dirty'

5. Restore UI state
   - Load all tabs from tabs collection, sorted by order
   - Set active tab from app_state['last_active_tab_id']
   - Restore window bounds from app_state['window_bounds']
   - Load catalog_entries for sidebar

6. Begin health monitoring
   - Start 60-second health check interval for DuckDB Worker
   - Push initial worker_health record to Dexie.js

7. Application is interactive
```

### During Use

- **Query execution**: User types SQL -> `queries` entry created with `status: 'running'` -> DuckDB Worker executes -> Arrow IPC results stream directly to Renderer via MessagePort (never stored in Dexie.js) -> Renderer displays in data grid -> `queries` entry updated with final status, row count, execution time -> `query_history` entry pushed via CatalogSyncBridge for both Dexie.js and DuckDB `_query_history` table.

- **Catalog browsing**: User navigates to catalog view -> `catalog_entries` queried via `useLiveQuery()` -> User clicks table -> `column_schemas` queried with compound index `[catalogEntryId+columnName]` -> Detail panel renders.

- **Tab management**: User creates/closes/reorders tabs -> `tabs` collection updated -> `app_state['last_active_tab_id']` updated on tab switch.

- **Health monitoring**: Every 60 seconds, WorkerManager pings DuckDB Worker -> Response updates `worker_health` in Dexie.js -> StatusBar reflects current state. If no response within 5 seconds, worker marked `'degraded'` and restart initiated (up to `maxRestartAttempts`).

- **Configuration changes**: User adjusts setting in Settings UI -> Dexie.js `preferences` updated (immediate reactive effect) -> IPC message to Main Process -> `config.json` updated on disk.

### Shutdown (Graceful)

```
1. Stop accepting new queries
   - QueryRouter rejects new requests with 'shutting_down' error

2. Save UI state to Dexie.js
   - Flush all pending tab state writes
   - Write app_state['shutdown_status'] = 'clean'
   - Write app_state['window_bounds'] with current geometry
   - Write app_state['last_active_tab_id']

3. Shutdown DuckDB Worker (5-second timeout)
   - Cancel any running queries
   - Drain query queue
   - Run CHECKPOINT (flush WAL to database file)
   - Close DuckDB connection
   - Terminate Worker Thread

4. If DuckDB Worker does not respond within 5 seconds:
   - Force-terminate the Worker Thread
   - WAL will be replayed on next startup (safe but slower)

5. Write final config.json (if any settings changed)

6. Application exits

Total shutdown budget: <= 6 seconds (SC-009)
```

### Crash Recovery

```
1. Detect abnormal shutdown
   - On startup, check app_state['shutdown_status']
   - If 'dirty' (or missing): prior shutdown was abnormal

2. DuckDB recovery
   - DuckDB automatically replays WAL on open
   - Run PRAGMA integrity_check
   - If integrity check passes:
     -> Write recovery_log entry (type: 'wal_recovery', outcome: 'recovered')
   - If integrity check fails:
     -> Write recovery_log entry (type: 'integrity_check', outcome: 'degraded')
     -> Notify user via StatusBar warning
     -> Application remains usable (registered tables may still be intact)

3. Dexie.js recovery
   - IndexedDB handles its own crash recovery via Chromium's LevelDB journal
   - Dexie.js opens normally; uncommitted transactions are rolled back
   - Tab state reflects the last successfully committed writes

4. Reconciliation
   - Compare DuckDB information_schema.tables with catalog_entries in Dexie.js
   - If DuckDB has tables not in Dexie.js: create missing catalog_entries
   - If Dexie.js has entries not in DuckDB: mark status as 'removed'
   - Write reconciliation results to recovery_log

5. Resume normal operation
   - Set app_state['shutdown_status'] = 'dirty' (normal startup marker)
   - Restore tabs and continue
```

---

*Data Model document for the Electron Foundation (Phase 1) feature specification.*
*Architecture References: [04-database-integration.md](../../context/artifacts/design/04-database-integration.md), [data-model-spec.md](../../context/artifacts/data-model/data-model-spec.md)*
