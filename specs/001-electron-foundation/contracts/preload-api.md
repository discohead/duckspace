# API Contract: Preload Bridge API (Phase 1)

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)
**Date**: 2026-02-05
**Sources**: [ipc-api-spec.md](../../../context/artifacts/api-spec/ipc-api-spec.md), [02-electron-process-model.md](../../../context/artifacts/design/02-electron-process-model.md)

---

## Overview

The preload script exposes a typed API via `contextBridge.exposeInMainWorld('duckspace', api)`. This is the **sole interface** between the sandboxed Renderer Process and the privileged Main Process. The Renderer never calls `ipcRenderer` directly; all communication flows through `window.duckspace`.

Phase 1 exposes three namespaces: `query`, `catalog`, and `lifecycle`. Additional namespaces (`search`, `ai`, `ingest`, `publish`, `config`, `on`) are defined in the full IPC API spec and will be added in later phases.

### Security Model

| Property | Value |
|----------|-------|
| `contextIsolation` | `true` |
| `sandbox` | `false` |
| `nodeIntegration` | `false` |
| `webSecurity` | `true` |

The Renderer cannot access `require`, `process`, `Buffer`, `fs`, or any Node.js APIs. The preload script runs with `sandbox: false` so it can use `ipcRenderer` and `contextBridge`, but `contextIsolation: true` ensures the Renderer's JavaScript context is fully isolated from the preload. All system access flows through the preload bridge methods exposed via `contextBridge.exposeInMainWorld()`.

---

## Type Definitions

These types are shared across the preload API. They should be defined in `src/shared/types.ts` and imported by both the preload script and Renderer components.

```typescript
// ============================================================
// Core Types
// ============================================================

/** Handle returned when a query is submitted for execution */
interface QueryHandle {
  /** UUID for tracking this query execution */
  queryId: string;
}

/** Query execution status */
type QueryExecutionStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Status update pushed during query execution */
interface QueryStatus {
  queryId: string;
  phase: 'scanning' | 'filtering' | 'aggregating' | 'sorting' | 'streaming';
  rowsScanned?: number;
  rowsFiltered?: number;
  batchesStreamed: number;
  estimatedTotalBatches?: number;
  elapsedMs: number;
}

/** A single Arrow IPC batch received from the data plane */
interface ArrowBatch {
  /** Arrow IPC ArrayBuffer containing RecordBatch data */
  buffer: ArrayBuffer;
  /** 0-based batch sequence number */
  index: number;
  /** Number of rows in this batch */
  rowCount: number;
  /** Size in bytes */
  byteSize: number;
  /** Whether this is the last batch */
  isLast: boolean;
}

/** Catalog entry representing a registered DuckDB table or view */
interface CatalogEntry {
  id: string;
  name: string;
  schema: string;
  type: 'table' | 'view';
  columnCount: number;
  rowCount: number;
  sizeBytes: number;
  status: 'active' | 'removed' | 'error';
  registeredAt: string;
}

/** Column schema information */
interface ColumnSchema {
  name: string;
  duckdbType: string;
  arrowType: string;
  nullable: boolean;
  ordinalPosition: number;
}

/** Worker health status pushed from Main Process */
interface WorkerHealth {
  worker: 'duckdb';
  status: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';
  restartCount?: number;
  message?: string;
}

/** Application state information */
interface AppState {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  userDataPath: string;
  memory: {
    totalSystemMB: number;
    freeSystemMB: number;
    duckdbLimitMB: number;
  };
  workers: {
    duckdb: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';
  };
  shutdownStatus: 'clean' | 'dirty';
}

/** Standard IPC error */
interface IPCError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}
```

---

## Complete API Surface

```typescript
interface DuckspaceAPI {
  query: QueryNamespace;
  catalog: CatalogNamespace;
  lifecycle: LifecycleNamespace;
}

declare global {
  interface Window {
    duckspace: DuckspaceAPI;
  }
}
```

---

## `window.duckspace.query` Namespace

### `execute(sql, params?)`

Submit a SQL query for execution against DuckDB. The method returns immediately with a `QueryHandle` containing the `queryId`. Result data arrives asynchronously as Arrow IPC batches on the `duckdb-data` MessagePort channel.

#### Signature

```typescript
execute(sql: string, params?: unknown[]): Promise<QueryHandle>
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `sql` | `string` | Yes | SQL query string. Use `$1`, `$2`, ... for parameter placeholders. |
| `params` | `unknown[]` | No | Positional parameter values for binding. Must match the number of `$N` placeholders. |

#### Return Type

```typescript
Promise<QueryHandle>
// Resolves to: { queryId: string }
```

#### Error Cases

| Code | Condition | Retryable |
|------|-----------|-----------|
| `E1001` | SQL syntax error | No |
| `E1004` | Referenced table does not exist | No |
| `E1005` | Referenced column does not exist | No |
| `E1006` | Parameter type mismatch | No |
| `E1007` | DuckDB memory limit exceeded | Yes |
| `E1012` | DDL/DML rejected (readOnly enforcement) | No |
| `E6001` | DuckDB Worker crashed | Yes (after restart) |
| `E6006` | Application shutting down | No |

#### Usage Example

```typescript
// Simple query
const { queryId } = await window.duckspace.query.execute('SELECT 42 AS answer');

// Parameterized query
const { queryId } = await window.duckspace.query.execute(
  'SELECT * FROM sales WHERE region = $1 AND year >= $2 ORDER BY amount DESC LIMIT $3',
  ['West', 2024, 1000]
);

// Handle errors
try {
  const handle = await window.duckspace.query.execute('SELECT * FROM nonexistent');
} catch (err) {
  const ipcError = err as IPCError;
  if (ipcError.code === 'E1004') {
    showError('Table not found');
  }
}
```

---

### `cancel(queryId)`

Cancel a running query. Stops DuckDB execution and halts Arrow IPC streaming. The cancellation takes effect within 1 second per spec requirement SC-004.

#### Signature

```typescript
cancel(queryId: string): Promise<void>
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `queryId` | `string` | Yes | The `queryId` from the `QueryHandle` returned by `execute()`. |

#### Return Type

```typescript
Promise<void>
// Resolves when cancellation is confirmed
```

#### Error Cases

| Code | Condition | Retryable |
|------|-----------|-----------|
| `E1003` | Query already cancelled or completed | No |
| `E6003` | IPC timeout | Yes |

#### Usage Example

```typescript
const { queryId } = await window.duckspace.query.execute('SELECT * FROM huge_table');

// User clicks cancel button
await window.duckspace.query.cancel(queryId);
// No further Arrow batches arrive for this queryId
```

---

### `onStatus(callback)`

Subscribe to query execution status updates. The callback fires whenever a running query's phase changes or progress updates arrive. Returns an unsubscribe function.

#### Signature

```typescript
onStatus(callback: (status: QueryStatus) => void): () => void
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `callback` | `(status: QueryStatus) => void` | Yes | Invoked on each status update. |

#### Return Type

```typescript
() => void
// Call the returned function to unsubscribe
```

#### Error Cases

None. This is a subscription; errors in the query are delivered via the data plane (`arrow-error` message on MessagePort).

#### Usage Example

```typescript
// In a React component
useEffect(() => {
  const unsub = window.duckspace.query.onStatus((status) => {
    if (status.queryId === activeQueryId) {
      setQueryProgress({
        phase: status.phase,
        batches: status.batchesStreamed,
        elapsed: status.elapsedMs,
      });
    }
  });

  return unsub; // Cleanup on unmount
}, [activeQueryId]);
```

---

### `onData(queryId, callback)`

Subscribe to Arrow IPC data batches for a specific query. The callback fires for each batch arriving on the `duckdb-data` MessagePort. Returns an unsubscribe function.

**Implementation note**: The preload script internally listens on the MessagePort and routes batches to registered callbacks by `queryId`. The Renderer never interacts with the MessagePort directly.

#### Signature

```typescript
onData(queryId: string, callback: (batch: ArrowBatch) => void): () => void
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `queryId` | `string` | Yes | The `queryId` to listen for. |
| `callback` | `(batch: ArrowBatch) => void` | Yes | Invoked for each Arrow batch. The `buffer` field contains the raw Arrow IPC `ArrayBuffer`. |

#### Return Type

```typescript
() => void
// Call the returned function to unsubscribe and stop receiving batches
```

#### Error Cases

If a query error occurs, the data plane delivers an `arrow-error` message. The preload script translates this into a special `ArrowBatch` with `isLast: true` and a zero-length buffer, or the Renderer can check for errors via `onStatus`.

#### Usage Example

```typescript
const { queryId } = await window.duckspace.query.execute('SELECT * FROM sales');

const allBatches: ArrowBatch[] = [];

const unsub = window.duckspace.query.onData(queryId, (batch) => {
  allBatches.push(batch);

  // Decode Arrow IPC using Flechette
  const table = tableFromIPC(batch.buffer);
  appendToGrid(table);

  if (batch.isLast) {
    console.log(`Query complete: ${allBatches.length} batches`);
    unsub();
  }
});

// Full pattern: execute + subscribe
async function runQuery(sql: string): Promise<void> {
  const { queryId } = await window.duckspace.query.execute(sql);

  return new Promise((resolve, reject) => {
    const unsub = window.duckspace.query.onData(queryId, (batch) => {
      if (batch.byteSize === 0 && batch.isLast) {
        // Error case -- check status
        unsub();
        reject(new Error('Query failed'));
        return;
      }

      const table = tableFromIPC(batch.buffer);
      renderBatch(table);

      if (batch.isLast) {
        unsub();
        resolve();
      }
    });
  });
}
```

---

## `window.duckspace.catalog` Namespace

### `listTables()`

List all registered tables and views in DuckDB. Returns summary metadata suitable for the catalog browser sidebar.

#### Signature

```typescript
listTables(): Promise<CatalogEntry[]>
```

#### Parameters

None.

#### Return Type

```typescript
Promise<CatalogEntry[]>
```

#### Error Cases

| Code | Condition | Retryable |
|------|-----------|-----------|
| `E6001` | DuckDB Worker crashed | Yes (after restart) |
| `E6003` | IPC timeout | Yes |

#### Usage Example

```typescript
const tables = await window.duckspace.catalog.listTables();

// Display in sidebar
tables.forEach((entry) => {
  console.log(`${entry.name} (${entry.type}): ${entry.rowCount} rows, ${entry.columnCount} columns`);
});

// Filter active tables only
const activeTables = tables.filter((t) => t.status === 'active');
```

---

### `describeTable(tableName)`

Get detailed column schema for a specific table. Returns column names, DuckDB types, Arrow type equivalents, nullability, and ordinal positions.

#### Signature

```typescript
describeTable(tableName: string): Promise<ColumnSchema[]>
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tableName` | `string` | Yes | DuckDB table or view name. |

#### Return Type

```typescript
Promise<ColumnSchema[]>
```

#### Error Cases

| Code | Condition | Retryable |
|------|-----------|-----------|
| `E1004` | Table does not exist | No |
| `E6001` | DuckDB Worker crashed | Yes (after restart) |
| `E6003` | IPC timeout | Yes |

#### Usage Example

```typescript
const columns = await window.duckspace.catalog.describeTable('sales');

columns.forEach((col) => {
  console.log(`${col.name}: ${col.duckdbType} (Arrow: ${col.arrowType})${col.nullable ? ' NULLABLE' : ''}`);
});

// Output:
// id: INTEGER (Arrow: Int32)
// region: VARCHAR (Arrow: Utf8) NULLABLE
// amount: DOUBLE (Arrow: Float64) NULLABLE
// sale_date: DATE (Arrow: Date32)
```

---

### `previewTable(tableName, limit?)`

Get sample rows from a table. Returns a `QueryHandle` -- the actual data arrives as Arrow IPC batches on the data plane, identical to `query.execute()`.

Internally executes `SELECT * FROM <tableName> LIMIT <limit>` without a full table scan.

#### Signature

```typescript
previewTable(tableName: string, limit?: number): Promise<QueryHandle>
```

#### Parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `tableName` | `string` | Yes | -- | DuckDB table or view name. |
| `limit` | `number` | No | `100` | Number of sample rows to retrieve. |

#### Return Type

```typescript
Promise<QueryHandle>
// Resolves to: { queryId: string }
```

#### Error Cases

| Code | Condition | Retryable |
|------|-----------|-----------|
| `E1004` | Table does not exist | No |
| `E6001` | DuckDB Worker crashed | Yes (after restart) |

#### Usage Example

```typescript
// Preview first 50 rows of a table
const { queryId } = await window.duckspace.catalog.previewTable('products', 50);

// Subscribe to data exactly like a regular query
const unsub = window.duckspace.query.onData(queryId, (batch) => {
  const table = tableFromIPC(batch.buffer);
  renderPreviewGrid(table);

  if (batch.isLast) unsub();
});
```

---

## `window.duckspace.lifecycle` Namespace

### `onWorkerHealth(callback)`

Subscribe to worker health status changes. The callback fires whenever the DuckDB Worker's health status changes (e.g., from `ready` to `busy`, or from `degraded` to `restarting`). Returns an unsubscribe function.

#### Signature

```typescript
onWorkerHealth(callback: (health: WorkerHealth) => void): () => void
```

#### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `callback` | `(health: WorkerHealth) => void` | Yes | Invoked on health status change. |

#### Return Type

```typescript
() => void
// Call to unsubscribe
```

#### Error Cases

None. This is a subscription.

#### Usage Example

```typescript
// StatusBar component
useEffect(() => {
  const unsub = window.duckspace.lifecycle.onWorkerHealth((health) => {
    setWorkerStatus(health.status);

    if (health.status === 'failed') {
      showAlert(`Database engine failed after ${health.restartCount} restart attempts`);
    } else if (health.status === 'restarting') {
      showToast('Database engine is restarting...');
    }
  });

  return unsub;
}, []);
```

---

### `getAppState()`

Get current application state including version info, system memory, worker status, and shutdown status. Used for the Settings panel, diagnostics, and startup recovery logic.

#### Signature

```typescript
getAppState(): Promise<AppState>
```

#### Parameters

None.

#### Return Type

```typescript
Promise<AppState>
```

#### Error Cases

| Code | Condition | Retryable |
|------|-----------|-----------|
| `E6003` | IPC timeout | Yes |

#### Usage Example

```typescript
const state = await window.duckspace.lifecycle.getAppState();

console.log(`duckspace v${state.version} on ${state.platform} ${state.arch}`);
console.log(`System RAM: ${state.memory.totalSystemMB} MB`);
console.log(`DuckDB limit: ${state.memory.duckdbLimitMB} MB`);
console.log(`DuckDB worker: ${state.workers.duckdb}`);

// Check for dirty shutdown (crash recovery)
if (state.shutdownStatus === 'dirty') {
  console.warn('Previous session did not shut down cleanly');
  await runRecoveryCheck();
}
```

---

## Internal Lifecycle Methods

These methods are called by the Renderer's bootstrap code and shutdown handler. They are not typically called by application components.

### `lifecycle.ready()`

Signal to Main Process that the Renderer is fully initialized.

```typescript
// Called once during bootstrap, after:
// 1. React hydration complete
// 2. Dexie.js database open
// 3. MessagePort channels connected
// 4. Initial UI state restored from Dexie.js
await window.duckspace.lifecycle.ready();
```

### `lifecycle.shutdownAck()`

Acknowledge that the Renderer has saved all state and is ready for shutdown.

```typescript
// Called in response to 'shutdown-prepare' push event
await window.duckspace.lifecycle.shutdownAck();
```

### `lifecycle.onShutdownPrepare(callback)`

Subscribe to the shutdown preparation signal from Main Process.

```typescript
const unsub = window.duckspace.lifecycle.onShutdownPrepare(async () => {
  // Flush all Dexie.js pending writes
  await db.tabs.toArray(); // force any pending transactions
  // Save final UI state
  await db.app_state.put({ id: 'shutdown_status', value: 'clean', updatedAt: new Date().toISOString() });
  await db.app_state.put({ id: 'window_bounds', value: getCurrentWindowBounds(), updatedAt: new Date().toISOString() });
  await db.app_state.put({ id: 'last_active_tab_id', value: getActiveTabId(), updatedAt: new Date().toISOString() });

  // Acknowledge
  await window.duckspace.lifecycle.shutdownAck();
});
```

---

## Preload Implementation Reference

The preload script implements the `DuckspaceAPI` by wrapping `ipcRenderer.invoke()` and `ipcRenderer.on()`. This is the reference implementation pattern:

```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// MessagePort storage (received via 'port' event before contextBridge setup)
const ports = new Map<string, MessagePort>();
const dataCallbacks = new Map<string, Set<(batch: ArrowBatch) => void>>();

// Receive MessagePorts from Main Process
ipcRenderer.on('port', (event: IpcRendererEvent, { channel }: { channel: string }) => {
  const [port] = event.ports;
  ports.set(channel, port);

  if (channel === 'duckdb-data') {
    port.onmessage = (msgEvent: MessageEvent) => {
      const msg = msgEvent.data;
      if (msg.type === 'arrow-batch' || msg.type === 'arrow-end' || msg.type === 'arrow-error') {
        const callbacks = dataCallbacks.get(msg.queryId);
        if (callbacks) {
          const batch: ArrowBatch = {
            buffer: msg.type === 'arrow-batch' ? msgEvent.data.__arrowBuffer ?? new ArrayBuffer(0) : new ArrayBuffer(0),
            index: msg.index ?? 0,
            rowCount: msg.rowCount ?? 0,
            byteSize: msg.byteSize ?? 0,
            isLast: msg.type === 'arrow-end' || msg.type === 'arrow-error',
          };
          callbacks.forEach((cb) => cb(batch));

          // Send ACK for backpressure
          if (msg.type === 'arrow-batch') {
            port.postMessage({ type: 'ack', queryId: msg.queryId, index: msg.index });
          }
        }
      }
    };
    port.start();
  }
});

contextBridge.exposeInMainWorld('duckspace', {
  // === Query Namespace ===
  query: {
    execute: (sql: string, params?: unknown[]) =>
      ipcRenderer.invoke('query:execute', { sql, params }),

    cancel: (queryId: string) =>
      ipcRenderer.invoke('query:cancel', { queryId }),

    onStatus: (callback: (status: QueryStatus) => void) => {
      const handler = (_: IpcRendererEvent, data: QueryStatus) => callback(data);
      ipcRenderer.on('query:progress', handler);
      return () => ipcRenderer.removeListener('query:progress', handler);
    },

    onData: (queryId: string, callback: (batch: ArrowBatch) => void) => {
      if (!dataCallbacks.has(queryId)) {
        dataCallbacks.set(queryId, new Set());
      }
      dataCallbacks.get(queryId)!.add(callback);
      return () => {
        const set = dataCallbacks.get(queryId);
        if (set) {
          set.delete(callback);
          if (set.size === 0) dataCallbacks.delete(queryId);
        }
      };
    },
  },

  // === Catalog Namespace ===
  catalog: {
    listTables: () =>
      ipcRenderer.invoke('query:listTables'),

    describeTable: (tableName: string) =>
      ipcRenderer.invoke('query:describeTable', { tableName }),

    previewTable: (tableName: string, limit?: number) =>
      ipcRenderer.invoke('catalog:preview', { tableName, limit: limit ?? 100 }),
  },

  // === Lifecycle Namespace ===
  lifecycle: {
    ready: () =>
      ipcRenderer.invoke('lifecycle:ready'),

    getAppState: () =>
      ipcRenderer.invoke('lifecycle:getAppState'),

    shutdownAck: () =>
      ipcRenderer.invoke('lifecycle:shutdownAck'),

    onWorkerHealth: (callback: (health: WorkerHealth) => void) => {
      const handler = (_: IpcRendererEvent, data: WorkerHealth) => callback(data);
      ipcRenderer.on('worker:status', handler);
      return () => ipcRenderer.removeListener('worker:status', handler);
    },

    onShutdownPrepare: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('shutdown-prepare', handler);
      return () => ipcRenderer.removeListener('shutdown-prepare', handler);
    },
  },
} satisfies DuckspaceAPI);
```

---

## Type Declaration File

For TypeScript consumers in the Renderer, declare the global type:

```typescript
// src/renderer/types/duckspace.d.ts

interface QueryHandle {
  queryId: string;
}

interface QueryStatus {
  queryId: string;
  phase: 'scanning' | 'filtering' | 'aggregating' | 'sorting' | 'streaming';
  rowsScanned?: number;
  rowsFiltered?: number;
  batchesStreamed: number;
  estimatedTotalBatches?: number;
  elapsedMs: number;
}

interface ArrowBatch {
  buffer: ArrayBuffer;
  index: number;
  rowCount: number;
  byteSize: number;
  isLast: boolean;
}

interface CatalogEntry {
  id: string;
  name: string;
  schema: string;
  type: 'table' | 'view';
  columnCount: number;
  rowCount: number;
  sizeBytes: number;
  status: 'active' | 'removed' | 'error';
  registeredAt: string;
}

interface ColumnSchema {
  name: string;
  duckdbType: string;
  arrowType: string;
  nullable: boolean;
  ordinalPosition: number;
}

interface WorkerHealth {
  worker: 'duckdb';
  status: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';
  restartCount?: number;
  message?: string;
}

interface AppState {
  version: string;
  electronVersion: string;
  platform: string;
  arch: string;
  userDataPath: string;
  memory: {
    totalSystemMB: number;
    freeSystemMB: number;
    duckdbLimitMB: number;
  };
  workers: {
    duckdb: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';
  };
  shutdownStatus: 'clean' | 'dirty';
}

interface IPCError {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

interface QueryNamespace {
  execute(sql: string, params?: unknown[]): Promise<QueryHandle>;
  cancel(queryId: string): Promise<void>;
  onStatus(callback: (status: QueryStatus) => void): () => void;
  onData(queryId: string, callback: (batch: ArrowBatch) => void): () => void;
}

interface CatalogNamespace {
  listTables(): Promise<CatalogEntry[]>;
  describeTable(tableName: string): Promise<ColumnSchema[]>;
  previewTable(tableName: string, limit?: number): Promise<QueryHandle>;
}

interface LifecycleNamespace {
  ready(): Promise<void>;
  getAppState(): Promise<AppState>;
  shutdownAck(): Promise<void>;
  onWorkerHealth(callback: (health: WorkerHealth) => void): () => void;
  onShutdownPrepare(callback: () => void): () => void;
}

interface DuckspaceAPI {
  query: QueryNamespace;
  catalog: CatalogNamespace;
  lifecycle: LifecycleNamespace;
}

declare global {
  interface Window {
    duckspace: DuckspaceAPI;
  }
}

export {};
```

---

*Preload Bridge API contract for the Electron Foundation (Phase 1) feature specification.*
