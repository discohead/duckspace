# API Contract: Dexie.js Database Schema (Phase 1)

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md) | **Data Model**: [data-model.md](../data-model.md)
**Date**: 2026-02-05
**Sources**: [04-database-integration.md](../../../context/artifacts/design/04-database-integration.md), [data-model.md](../data-model.md)

---

## Overview

Dexie.js provides reactive state management for the duckspace Renderer Process via IndexedDB. It stores UI state, metadata mirrors, and application configuration that must be reactive (auto-updating React components via `useLiveQuery`) and persistent across sessions.

Key architectural constraints:

- Dexie.js runs **entirely in the Renderer Process**. The Main Process never reads or writes to IndexedDB directly.
- When the Main Process produces metadata updates (e.g., after table registration, health checks), it pushes them to the Renderer via `webContents.send()` and the Renderer writes to Dexie.js.
- Query **result data** (Arrow IPC buffers) is never stored in Dexie.js. Only query metadata (status, timing, row counts) is persisted.
- All Dexie.js writes are IndexedDB transactions: atomic and crash-safe.

---

## Database Definition

| Property | Value |
|----------|-------|
| **Database name** | `Duckspace` |
| **Schema version** | `1` |
| **Collections** | 9 |
| **Storage location** | `~/Library/Application Support/Duckspace/IndexedDB/` (managed by Chromium) |
| **Library** | Dexie.js ^4.3.0 with `dexie-react-hooks` |

### Complete Schema Declaration

```typescript
// src/renderer/stores/db.ts

import Dexie, { type Table } from 'dexie';

export class DuckspaceDB extends Dexie {
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
    super('Duckspace');

    this.version(1).stores({
      // Tab management - indexed by type and display order
      tabs: 'id, type, order',

      // Query execution tracking - indexed by tab, status, and start time
      queries: 'id, tabId, status, startedAt',

      // Catalog entries (mirrors DuckDB tables) - indexed for browsing and filtering
      catalog_entries: 'id, name, type, status, registeredAt',

      // Per-column schema details - compound index for table+column lookup
      column_schemas: 'id, catalogEntryId, [catalogEntryId+columnName]',

      // Query history - timestamp for ordering, multi-entry index on tags
      query_history: 'id, timestamp, *tags',

      // User preferences - simple key-value
      preferences: 'id',

      // Worker health status - one record per worker
      worker_health: 'id',

      // Crash recovery audit log - ordered by timestamp
      recovery_log: 'id, timestamp',

      // Application-level singleton state entries
      app_state: 'id',
    });
  }
}

const db = new DuckspaceDB();
export default db;
```

### Index Reference

Dexie.js index syntax:

| Syntax | Meaning |
|--------|---------|
| `id` | Primary key (also creates an index) |
| `field` | Simple index on `field` |
| `[a+b]` | Compound index on fields `a` and `b` together |
| `*field` | Multi-entry index (one index entry per array element) |
| `++field` | Auto-incremented primary key |
| `&field` | Unique index |

---

## Collection: `tabs`

Persists open tabs across sessions. Drives the tab bar UI and restores tab state on relaunch.

### Dexie Index Definition

```
'id, type, order'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Direct tab lookup |
| `type` | Simple | Filter tabs by content type |
| `order` | Simple | Sort tabs for display order in tab bar |

### TypeScript Interface

```typescript
interface Tab {
  /** UUID primary key */
  id: string;

  /** Tab content type */
  type: 'query' | 'catalog' | 'settings';

  /** Display order in the tab bar (0-based) */
  order: number;

  /** Tab display title (e.g., "Query 1", "Data Catalog", "Settings") */
  title: string;

  /** Whether this is the currently active/focused tab */
  active: boolean;

  /**
   * Tab-type-specific persisted state.
   * Shape depends on `type`:
   *
   * type 'query':   QueryTabState
   * type 'catalog': CatalogTabState
   * type 'settings': SettingsTabState
   */
  state: QueryTabState | CatalogTabState | SettingsTabState;

  /** ISO timestamp of last user interaction with this tab */
  lastAccessedAt: string;
}

interface QueryTabState {
  /** SQL text in the editor */
  sql: string;
  /** Cursor position (character offset) */
  cursorPosition?: number;
  /** Editor scroll offset */
  scrollTop?: number;
}

interface CatalogTabState {
  /** Currently selected table name */
  selectedTable?: string;
  /** Expanded tree nodes in the catalog browser */
  expandedNodes?: string[];
}

interface SettingsTabState {
  /** Currently visible settings section */
  section?: string;
}
```

### Example Records

```typescript
// Query editor tab
{
  id: 'tab-001',
  type: 'query',
  order: 0,
  title: 'Query 1',
  active: true,
  state: {
    sql: 'SELECT region, SUM(amount) FROM sales GROUP BY region',
    cursorPosition: 52,
    scrollTop: 0,
  },
  lastAccessedAt: '2026-02-05T14:30:00.000Z',
}

// Catalog browser tab
{
  id: 'tab-002',
  type: 'catalog',
  order: 1,
  title: 'Data Catalog',
  active: false,
  state: {
    selectedTable: 'sales',
    expandedNodes: ['sales', 'products'],
  },
  lastAccessedAt: '2026-02-05T14:25:00.000Z',
}
```

---

## Collection: `queries`

Tracks the execution lifecycle of each SQL query. One active query per tab at a time. Historical queries for a tab remain in the collection.

### Dexie Index Definition

```
'id, tabId, status, startedAt'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Direct query lookup by queryId |
| `tabId` | Simple | Find all queries belonging to a tab |
| `status` | Simple | Filter queries by execution state |
| `startedAt` | Simple | Order queries chronologically |

### TypeScript Interface

```typescript
interface Query {
  /** UUID primary key (matches queryId from IPC) */
  id: string;

  /** Reference to tabs.id -- which tab initiated this query */
  tabId: string;

  /** The SQL statement that was executed */
  sql: string;

  /** Current execution status */
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

  /** ISO timestamp when execution started */
  startedAt: string;

  /** ISO timestamp when execution completed (any terminal state) */
  completedAt?: string;

  /** Execution duration in milliseconds */
  executionTimeMs?: number;

  /** Number of rows in the result set */
  rowCount?: number;

  /** Human-readable error message (if status is 'failed') */
  errorMessage?: string;

  /** Error taxonomy code E1xxx-E9xxx (if status is 'failed') */
  errorCode?: string;
}
```

### Example Records

```typescript
// Running query
{
  id: 'q-abc-123',
  tabId: 'tab-001',
  sql: 'SELECT * FROM sales WHERE year = 2025',
  status: 'running',
  startedAt: '2026-02-05T14:30:05.000Z',
}

// Completed query
{
  id: 'q-abc-124',
  tabId: 'tab-001',
  sql: 'SELECT region, SUM(amount) FROM sales GROUP BY region',
  status: 'completed',
  startedAt: '2026-02-05T14:30:00.000Z',
  completedAt: '2026-02-05T14:30:00.350Z',
  executionTimeMs: 350,
  rowCount: 5,
}

// Failed query
{
  id: 'q-abc-125',
  tabId: 'tab-001',
  sql: 'SELECT * FROM nonexistent_table',
  status: 'failed',
  startedAt: '2026-02-05T14:29:00.000Z',
  completedAt: '2026-02-05T14:29:00.050Z',
  executionTimeMs: 50,
  errorMessage: 'Table "nonexistent_table" does not exist',
  errorCode: 'E1004',
}
```

---

## Collection: `catalog_entries`

Mirrors DuckDB's registered tables/views in the Renderer for reactive UI display. Updated by the CatalogSyncBridge when tables are registered, modified, or removed in DuckDB.

### Dexie Index Definition

```
'id, name, type, status, registeredAt'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Direct lookup by source identifier |
| `name` | Simple | Search/filter by table name |
| `type` | Simple | Filter tables vs. views |
| `status` | Simple | Filter active vs. removed entries |
| `registeredAt` | Simple | Order by registration time |

### TypeScript Interface

```typescript
interface CatalogEntry {
  /** UUID primary key (source identifier) */
  id: string;

  /** DuckDB table or view name */
  name: string;

  /** DuckDB schema (always 'main' in Phase 1) */
  schema: string;

  /** 'table' for persistent tables, 'view' for SQL views */
  type: 'table' | 'view';

  /** Current status */
  status: 'active' | 'removed' | 'error';

  /** Estimated row count from DuckDB */
  rowCount: number;

  /** Estimated storage size in bytes */
  sizeBytes: number;

  /** Number of columns */
  columnCount: number;

  /** ISO timestamp when the table was registered */
  registeredAt: string;

  /** ISO timestamp of the last query executed against this table */
  lastAccessedAt?: string;
}
```

### Example Records

```typescript
{
  id: 'src-001',
  name: 'sales',
  schema: 'main',
  type: 'table',
  status: 'active',
  rowCount: 1000000,
  sizeBytes: 48000000,
  columnCount: 8,
  registeredAt: '2026-02-05T10:00:00.000Z',
  lastAccessedAt: '2026-02-05T14:30:00.000Z',
}

{
  id: 'src-002',
  name: 'products',
  schema: 'main',
  type: 'table',
  status: 'active',
  rowCount: 500,
  sizeBytes: 24000,
  columnCount: 5,
  registeredAt: '2026-02-05T10:00:00.000Z',
}
```

---

## Collection: `column_schemas`

Stores per-column metadata for each catalog entry. Drives the column list in the catalog browser detail panel.

### Dexie Index Definition

```
'id, catalogEntryId, [catalogEntryId+columnName]'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Direct lookup (composite key: `{catalogEntryId}_{columnName}`) |
| `catalogEntryId` | Simple | All columns for a given catalog entry |
| `[catalogEntryId+columnName]` | Compound | Unique column within a table |

### TypeScript Interface

```typescript
interface ColumnSchemaRecord {
  /** Composite primary key: `{catalogEntryId}_{columnName}` */
  id: string;

  /** Reference to catalog_entries.id */
  catalogEntryId: string;

  /** Column name in DuckDB */
  columnName: string;

  /** DuckDB type (e.g., VARCHAR, INTEGER, DECIMAL(10,2), TIMESTAMP) */
  columnType: string;

  /** Arrow type equivalent (e.g., Utf8, Int32, Float64, Timestamp(us, UTC)) */
  arrowType: string;

  /** Whether column allows NULL values */
  nullable: boolean;

  /** 0-based column position in the table */
  ordinalPosition: number;
}
```

### Example Records

```typescript
{
  id: 'src-001_id',
  catalogEntryId: 'src-001',
  columnName: 'id',
  columnType: 'INTEGER',
  arrowType: 'Int32',
  nullable: false,
  ordinalPosition: 0,
}

{
  id: 'src-001_region',
  catalogEntryId: 'src-001',
  columnName: 'region',
  columnType: 'VARCHAR',
  arrowType: 'Utf8',
  nullable: false,
  ordinalPosition: 1,
}

{
  id: 'src-001_amount',
  catalogEntryId: 'src-001',
  columnName: 'amount',
  columnType: 'DOUBLE',
  arrowType: 'Float64',
  nullable: true,
  ordinalPosition: 2,
}
```

---

## Collection: `query_history`

UI-side mirror of DuckDB's `_query_history` table. Enables reactive display of query history with `useLiveQuery()`. The multi-entry index on `tags` allows querying by any individual tag.

### Dexie Index Definition

```
'id, timestamp, *tags'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Direct lookup (matches DuckDB `_query_history.query_id`) |
| `timestamp` | Simple | Order by execution time |
| `*tags` | Multi-entry | Find queries by any single tag value |

### TypeScript Interface

```typescript
interface QueryHistoryRecord {
  /** UUID primary key (matches _query_history.query_id in DuckDB) */
  id: string;

  /** The SQL statement that was executed */
  sql: string;

  /** Execution duration in milliseconds */
  executionTimeMs: number;

  /** Result set row count */
  rowCount: number;

  /** ISO timestamp of execution */
  timestamp: string;

  /** Origin: 'user' (manual execution) or 'system' (internal) */
  source: 'user' | 'system';

  /** User-assigned tags for organization */
  tags: string[];

  /** 'success' or 'error' */
  status: 'success' | 'error';

  /** Error details if status is 'error' */
  errorMessage?: string;
}
```

### Example Records

```typescript
{
  id: 'qh-001',
  sql: 'SELECT region, SUM(amount) FROM sales GROUP BY region',
  executionTimeMs: 350,
  rowCount: 5,
  timestamp: '2026-02-05T14:30:00.000Z',
  source: 'user',
  tags: ['sales', 'aggregation'],
  status: 'success',
}

{
  id: 'qh-002',
  sql: 'SELECT * FROM products WHERE category = $1',
  executionTimeMs: 45,
  rowCount: 23,
  timestamp: '2026-02-05T14:28:00.000Z',
  source: 'user',
  tags: ['products'],
  status: 'success',
}

{
  id: 'qh-003',
  sql: 'SELECT * FROM nonexistent',
  executionTimeMs: 12,
  rowCount: 0,
  timestamp: '2026-02-05T14:27:00.000Z',
  source: 'user',
  tags: [],
  status: 'error',
  errorMessage: 'Table "nonexistent" does not exist',
}
```

---

## Collection: `preferences`

Stores user preferences that the Renderer needs reactively. Changes take immediate effect via `useLiveQuery()`.

### Dexie Index Definition

```
'id'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Dot-notated preference key |

### TypeScript Interface

```typescript
interface Preference {
  /** Dot-notated key (e.g., 'appearance.theme', 'editor.fontSize') */
  id: string;

  /** Setting value (type depends on the key) */
  value: unknown;

  /** Grouping category */
  category: 'appearance' | 'editor' | 'memory' | 'advanced';

  /** ISO timestamp of last change */
  updatedAt: string;
}
```

### Default Preferences

| Key (`id`) | Default `value` | `category` | Description |
|------------|----------------|------------|-------------|
| `appearance.theme` | `'system'` | `appearance` | `'light'`, `'dark'`, or `'system'` |
| `appearance.fontSize` | `14` | `appearance` | Base font size in pixels |
| `editor.defaultLimit` | `1000` | `editor` | Default LIMIT for unbounded queries |
| `editor.autoComplete` | `true` | `editor` | Enable SQL autocomplete |
| `editor.tabSize` | `2` | `editor` | Tab width in the SQL editor |
| `memory.duckdbLimitPct` | `50` | `memory` | DuckDB memory as % of system RAM |

### Example Records

```typescript
{
  id: 'appearance.theme',
  value: 'dark',
  category: 'appearance',
  updatedAt: '2026-02-05T10:00:00.000Z',
}

{
  id: 'editor.defaultLimit',
  value: 1000,
  category: 'editor',
  updatedAt: '2026-02-05T10:00:00.000Z',
}
```

---

## Collection: `worker_health`

Tracks health status of each background worker. Phase 1 has exactly one record: `id: 'duckdb'`.

### Dexie Index Definition

```
'id'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | Worker identifier |

### TypeScript Interface

```typescript
interface WorkerHealthRecord {
  /** Worker identifier: 'duckdb' in Phase 1 */
  id: string;

  /** Current health status */
  status: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';

  /** Number of automatic restarts since app launch */
  restartCount: number;

  /** ISO timestamp of last successful heartbeat */
  lastHeartbeatAt: string;

  /** Most recent error message (if any) */
  lastErrorMessage?: string;

  /** ISO timestamp when the worker last started */
  upSince: string;

  /** Number of queries currently executing */
  activeQueryCount: number;
}
```

### Example Record

```typescript
{
  id: 'duckdb',
  status: 'ready',
  restartCount: 0,
  lastHeartbeatAt: '2026-02-05T14:30:00.000Z',
  upSince: '2026-02-05T10:00:00.000Z',
  activeQueryCount: 0,
}
```

---

## Collection: `recovery_log`

Audit log for crash detection and recovery actions. Written on startup when an abnormal prior shutdown is detected, and on worker restart events.

### Dexie Index Definition

```
'id, timestamp'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | UUID |
| `timestamp` | Simple | Order by event time |

### TypeScript Interface

```typescript
interface RecoveryLogEntry {
  /** UUID primary key */
  id: string;

  /** ISO timestamp of detection/event */
  timestamp: string;

  /** Event type */
  type: 'abnormal_shutdown' | 'integrity_check' | 'worker_restart' | 'wal_recovery';

  /** Human-readable description */
  details: string;

  /** Recovery outcome */
  outcome: 'recovered' | 'degraded' | 'failed';

  /** Worker ID that was affected (if applicable) */
  affectedWorker?: string;
}
```

### Example Records

```typescript
{
  id: 'rec-001',
  timestamp: '2026-02-05T10:00:00.000Z',
  type: 'abnormal_shutdown',
  details: 'Previous session did not shut down cleanly. Initiating recovery.',
  outcome: 'recovered',
}

{
  id: 'rec-002',
  timestamp: '2026-02-05T10:00:01.000Z',
  type: 'wal_recovery',
  details: 'DuckDB WAL replayed successfully. 3 committed transactions recovered.',
  outcome: 'recovered',
  affectedWorker: 'duckdb',
}

{
  id: 'rec-003',
  timestamp: '2026-02-05T12:45:00.000Z',
  type: 'worker_restart',
  details: 'DuckDB Worker became unresponsive. Automatic restart initiated (attempt 1/3).',
  outcome: 'recovered',
  affectedWorker: 'duckdb',
}
```

---

## Collection: `app_state`

Singleton application-level state entries. Each record is a key-value pair for state that does not fit in other collections.

### Dexie Index Definition

```
'id'
```

| Index | Type | Purpose |
|-------|------|---------|
| `id` | Primary key | State key |

### TypeScript Interface

```typescript
interface AppStateEntry {
  /** State key (e.g., 'shutdown_status', 'window_bounds') */
  id: string;

  /** State value (type depends on the key) */
  value: unknown;

  /** ISO timestamp of last update */
  updatedAt: string;
}
```

### Phase 1 State Keys

| Key (`id`) | Value Type | Description |
|------------|-----------|-------------|
| `shutdown_status` | `'clean' \| 'dirty'` | Set to `'dirty'` on launch, `'clean'` on graceful shutdown. If `'dirty'` on next launch, triggers crash recovery. |
| `window_bounds` | `{ x: number, y: number, width: number, height: number }` | Window position and size for restore |
| `session_id` | `string` | UUID for the current application session |
| `last_active_tab_id` | `string` | Tab ID to focus on restore |

### Example Records

```typescript
{
  id: 'shutdown_status',
  value: 'clean',
  updatedAt: '2026-02-05T14:30:00.000Z',
}

{
  id: 'window_bounds',
  value: { x: 100, y: 50, width: 1440, height: 900 },
  updatedAt: '2026-02-05T14:30:00.000Z',
}

{
  id: 'session_id',
  value: 'sess-abc-123',
  updatedAt: '2026-02-05T10:00:00.000Z',
}

{
  id: 'last_active_tab_id',
  value: 'tab-001',
  updatedAt: '2026-02-05T14:30:00.000Z',
}
```

---

## Reactive Query Patterns (`useLiveQuery`)

All examples use `dexie-react-hooks` and the `db` instance exported from `src/renderer/stores/db.ts`.

```typescript
import { useLiveQuery } from 'dexie-react-hooks';
import db from '../stores/db';
```

### Get Active Tabs (Sorted by Order)

Drives the tab bar. Re-renders whenever tabs are added, removed, reordered, or activated.

```typescript
function useActiveTabs(): Tab[] | undefined {
  return useLiveQuery(
    () => db.tabs.orderBy('order').toArray()
  );
}

// Usage in TabBar component
function TabBar() {
  const tabs = useActiveTabs();

  if (!tabs) return <TabBarSkeleton />;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          title={tab.title}
          active={tab.active}
          type={tab.type}
          onClick={() => activateTab(tab.id)}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  );
}
```

### Get Currently Active Tab

```typescript
function useActiveTab(): Tab | undefined {
  return useLiveQuery(
    () => db.tabs.filter((tab) => tab.active).first()
  );
}
```

### Get Query by Tab (Most Recent)

Shows the current query execution state in the query editor.

```typescript
function useCurrentQuery(tabId: string): Query | undefined {
  return useLiveQuery(
    () =>
      db.queries
        .where('tabId')
        .equals(tabId)
        .reverse()
        .sortBy('startedAt')
        .then((queries) => queries[0]),
    [tabId]
  );
}

// Usage in QueryEditor component
function QueryEditor({ tabId }: { tabId: string }) {
  const query = useCurrentQuery(tabId);

  return (
    <div className="query-editor">
      <StatusIndicator status={query?.status ?? 'idle'} />
      {query?.status === 'completed' && (
        <span>{query.rowCount} rows in {query.executionTimeMs}ms</span>
      )}
      {query?.status === 'failed' && (
        <ErrorBanner message={query.errorMessage} code={query.errorCode} />
      )}
    </div>
  );
}
```

### Get Running Queries (Across All Tabs)

Drives the global activity indicator in the status bar.

```typescript
function useRunningQueries(): Query[] | undefined {
  return useLiveQuery(
    () => db.queries.where('status').equals('running').toArray()
  );
}
```

### Get Catalog Entries (Active Tables)

Drives the catalog browser sidebar.

```typescript
function useCatalogEntries(): CatalogEntry[] | undefined {
  return useLiveQuery(
    () =>
      db.catalog_entries
        .where('status')
        .equals('active')
        .sortBy('name')
  );
}

// Usage in CatalogBrowser component
function CatalogBrowser() {
  const entries = useCatalogEntries();

  if (!entries) return <CatalogSkeleton />;

  return (
    <div className="catalog-browser">
      <h3>Tables ({entries.length})</h3>
      {entries.map((entry) => (
        <CatalogItem
          key={entry.id}
          name={entry.name}
          type={entry.type}
          rowCount={entry.rowCount}
          columnCount={entry.columnCount}
        />
      ))}
    </div>
  );
}
```

### Get Column Schemas for a Table

Drives the table detail panel in the catalog browser.

```typescript
function useColumnSchemas(catalogEntryId: string): ColumnSchemaRecord[] | undefined {
  return useLiveQuery(
    () =>
      db.column_schemas
        .where('catalogEntryId')
        .equals(catalogEntryId)
        .sortBy('ordinalPosition'),
    [catalogEntryId]
  );
}

// Usage in TableDetail component
function TableDetail({ entryId }: { entryId: string }) {
  const columns = useColumnSchemas(entryId);

  if (!columns) return <ColumnListSkeleton />;

  return (
    <table className="column-list">
      <thead>
        <tr><th>Column</th><th>Type</th><th>Nullable</th></tr>
      </thead>
      <tbody>
        {columns.map((col) => (
          <tr key={col.id}>
            <td>{col.columnName}</td>
            <td>{col.columnType}</td>
            <td>{col.nullable ? 'Yes' : 'No'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

### Get Query History (Recent, With Tag Filter)

```typescript
// All recent queries, newest first
function useRecentQueries(limit: number = 50): QueryHistoryRecord[] | undefined {
  return useLiveQuery(
    () =>
      db.query_history
        .orderBy('timestamp')
        .reverse()
        .limit(limit)
        .toArray()
  );
}

// Queries matching a specific tag
function useQueriesByTag(tag: string): QueryHistoryRecord[] | undefined {
  return useLiveQuery(
    () =>
      db.query_history
        .where('tags')
        .equals(tag)
        .reverse()
        .sortBy('timestamp'),
    [tag]
  );
}
```

### Get Worker Health Status

Drives the StatusBar health indicator.

```typescript
function useDuckDBHealth(): WorkerHealthRecord | undefined {
  return useLiveQuery(
    () => db.worker_health.get('duckdb')
  );
}

// Usage in StatusBar component
function StatusBar() {
  const health = useDuckDBHealth();

  if (!health) return <StatusBarSkeleton />;

  const color = {
    ready: 'green',
    busy: 'yellow',
    degraded: 'orange',
    restarting: 'orange',
    failed: 'red',
  }[health.status];

  return (
    <div className="status-bar">
      <HealthDot color={color} />
      <span>DuckDB: {health.status}</span>
      {health.activeQueryCount > 0 && (
        <span>({health.activeQueryCount} active)</span>
      )}
    </div>
  );
}
```

### Get User Preference

```typescript
function usePreference<T>(key: string, defaultValue: T): T {
  const pref = useLiveQuery(
    () => db.preferences.get(key),
    [key]
  );
  return (pref?.value as T) ?? defaultValue;
}

// Usage
function App() {
  const theme = usePreference<string>('appearance.theme', 'system');
  const fontSize = usePreference<number>('appearance.fontSize', 14);

  return (
    <div className={`app theme-${theme}`} style={{ fontSize }}>
      {/* ... */}
    </div>
  );
}
```

### Get App State Entry

```typescript
function useAppState<T>(key: string): T | undefined {
  const entry = useLiveQuery(
    () => db.app_state.get(key),
    [key]
  );
  return entry?.value as T | undefined;
}

// Check for dirty shutdown on startup
function useShutdownStatus(): 'clean' | 'dirty' | undefined {
  return useAppState<'clean' | 'dirty'>('shutdown_status');
}
```

---

## Write Patterns

### Create a New Tab

```typescript
async function createTab(type: Tab['type']): Promise<string> {
  const id = crypto.randomUUID();
  const maxOrder = await db.tabs.orderBy('order').last();
  const order = (maxOrder?.order ?? -1) + 1;

  // Deactivate all other tabs
  await db.tabs.toCollection().modify({ active: false });

  await db.tabs.add({
    id,
    type,
    order,
    title: type === 'query' ? `Query ${order + 1}` : type === 'catalog' ? 'Data Catalog' : 'Settings',
    active: true,
    state: type === 'query' ? { sql: '' } : type === 'catalog' ? {} : {},
    lastAccessedAt: new Date().toISOString(),
  });

  await db.app_state.put({
    id: 'last_active_tab_id',
    value: id,
    updatedAt: new Date().toISOString(),
  });

  return id;
}
```

### Close a Tab

```typescript
async function closeTab(tabId: string): Promise<void> {
  const tab = await db.tabs.get(tabId);
  if (!tab) return;

  await db.tabs.delete(tabId);

  // If closed tab was active, activate the nearest tab
  if (tab.active) {
    const remainingTabs = await db.tabs.orderBy('order').toArray();
    if (remainingTabs.length > 0) {
      const nearest = remainingTabs.find((t) => t.order >= tab.order) ?? remainingTabs[remainingTabs.length - 1];
      await db.tabs.update(nearest.id, { active: true });
      await db.app_state.put({
        id: 'last_active_tab_id',
        value: nearest.id,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // Reorder remaining tabs
  const allTabs = await db.tabs.orderBy('order').toArray();
  await db.transaction('rw', db.tabs, async () => {
    for (let i = 0; i < allTabs.length; i++) {
      await db.tabs.update(allTabs[i].id, { order: i });
    }
  });
}
```

### Record Query Execution

```typescript
async function recordQueryStart(queryId: string, tabId: string, sql: string): Promise<void> {
  await db.queries.add({
    id: queryId,
    tabId,
    sql,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
}

async function recordQueryComplete(
  queryId: string,
  rowCount: number,
  executionTimeMs: number
): Promise<void> {
  await db.queries.update(queryId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    executionTimeMs,
    rowCount,
  });
}

async function recordQueryFailed(
  queryId: string,
  errorCode: string,
  errorMessage: string,
  executionTimeMs: number
): Promise<void> {
  await db.queries.update(queryId, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    executionTimeMs,
    errorCode,
    errorMessage,
  });
}
```

### Handle CatalogSyncBridge Push

The Renderer listens for `catalog:change` push events from Main Process and writes to Dexie.js:

```typescript
// Called during Renderer bootstrap
function setupCatalogSync(): void {
  window.duckspace.on?.catalogChange?.((event) => {
    const { collection, action, data, key, keys } = event;
    const table = db.table(collection);

    switch (action) {
      case 'put':
        table.put(data as Record<string, unknown>);
        break;
      case 'add':
        table.add(data as Record<string, unknown>);
        break;
      case 'delete':
        if (key) table.delete(key);
        break;
      case 'bulkPut':
        table.bulkPut(data as Record<string, unknown>[]);
        break;
      case 'bulkDelete':
        if (keys) table.bulkDelete(keys);
        break;
    }
  });
}
```

**Note**: The `catalog:change` push event is available in the full API spec. In Phase 1, the Renderer may instead handle this through the lifecycle methods and explicit IPC calls to fetch catalog data after query execution completes.

---

## Migration Strategy

Phase 1 declares version 1 with all 9 collections. Future phases add collections or indexes via version increments:

```typescript
// Future: Phase 2 adds data ingestion collections
this.version(2).stores({
  ingestion_jobs: 'id, status, startedAt',
  // Existing collections unchanged -- Dexie preserves them automatically
});

// Future: Phase 5 adds AI/chat collections
this.version(3).stores({
  conversations: 'id, createdAt, updatedAt',
  messages: 'id, conversationId, timestamp, [conversationId+timestamp]',
}).upgrade((tx) => {
  // Data migration if needed
});
```

Migration guarantees:
- Migrations run within IndexedDB transactions (atomic and crash-safe)
- Adding new collections or indexes is non-destructive
- Only indexed properties need declaration; non-indexed properties are schemaless
- Dexie handles version skipping (v1 -> v3 runs both upgrades sequentially)

---

## Collection Size Estimates

| Collection | Estimated Max Rows | Record Size | Total Estimate |
|------------|-------------------|-------------|----------------|
| `tabs` | ~50 | ~500 B | ~25 KB |
| `queries` | ~500 (per session) | ~300 B | ~150 KB |
| `catalog_entries` | ~500 | ~200 B | ~100 KB |
| `column_schemas` | ~10,000 | ~150 B | ~1.5 MB |
| `query_history` | ~10,000 | ~400 B | ~4 MB |
| `preferences` | ~20 | ~100 B | ~2 KB |
| `worker_health` | 1 (Phase 1) | ~200 B | ~200 B |
| `recovery_log` | ~100 | ~300 B | ~30 KB |
| `app_state` | ~10 | ~200 B | ~2 KB |
| **Total** | | | **~6 MB** |

IndexedDB storage is effectively unlimited on desktop Electron (no quota prompts). These sizes are well within comfortable limits.

---

*Dexie.js Database Schema contract for the Electron Foundation (Phase 1) feature specification.*
