# API Contract: IPC Channels (Phase 1)

**Feature**: [spec.md](../spec.md) | **Plan**: [plan.md](../plan.md)
**Date**: 2026-02-05
**Sources**: [ipc-api-spec.md](../../../context/artifacts/api-spec/ipc-api-spec.md), [02-electron-process-model.md](../../../context/artifacts/design/02-electron-process-model.md)

---

## Architecture Summary

Phase 1 uses a **dual-plane IPC architecture**:

- **Control plane**: JSON-serializable messages via `ipcMain.handle()` / `ipcRenderer.invoke()` (request-response) and `webContents.send()` / `ipcRenderer.on()` (push events). Carries commands, status updates, and lifecycle signals.
- **Data plane**: Arrow IPC `ArrayBuffer` streams via `MessagePort` channels (zero-copy transfer). Carries query result data between the DuckDB Worker Thread and the Renderer Process.

The Main Process **never relays data-plane buffers**. Arrow data flows directly from Worker to Renderer via `MessagePort`.

```
Renderer <--contextBridge (invoke/handle)--> Main Process <--parentPort--> DuckDB Worker
Renderer <--------MessagePort (Arrow IPC, zero-copy)--------> DuckDB Worker
```

---

## Control Plane Channels

All control-plane channels use `ipcMain.handle()` / `ipcRenderer.invoke()` for request-response, or `webContents.send()` / `ipcRenderer.on()` for push events. The preload script wraps these in the `window.duckspace` API; the Renderer never calls `ipcRenderer` directly.

---

### `query:execute`

Submit a SQL query for execution against DuckDB.

| Property | Value |
|----------|-------|
| **Direction** | Renderer -> Main -> DuckDB Worker |
| **Pattern** | Request-Response (`ipcRenderer.invoke`) |
| **Data plane side-effect** | DuckDB Worker streams Arrow IPC batches to Renderer via `duckdb-data` MessagePort |

#### Request

```typescript
interface QueryExecuteRequest {
  /** SQL string with $1, $2, ... parameter placeholders */
  sql: string;
  /** Parameter values for binding (positional) */
  params?: unknown[];
}
```

#### Response

```typescript
interface QueryExecuteResponse {
  /** UUID assigned by the QueryRouter for tracking this execution */
  queryId: string;
}
```

#### Example

```typescript
// Renderer
const { queryId } = await window.duckspace.query.execute(
  'SELECT * FROM sales WHERE region = $1 LIMIT 100',
  ['West']
);
// queryId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
// Arrow IPC batches arrive on the duckdb-data MessagePort tagged with this queryId
```

#### Error Cases

| Code | Name | Condition |
|------|------|-----------|
| `E1001` | `QUERY_SYNTAX_ERROR` | SQL has syntax errors |
| `E1004` | `TABLE_NOT_FOUND` | Referenced table does not exist in DuckDB |
| `E1005` | `COLUMN_NOT_FOUND` | Referenced column does not exist |
| `E1006` | `TYPE_MISMATCH` | Parameter type incompatible with column type |
| `E1007` | `OUT_OF_MEMORY` | DuckDB memory limit exceeded and spill failed |
| `E1012` | `MUTATION_REJECTED` | DDL/DML statement rejected (readOnly enforcement) |
| `E6001` | `WORKER_CRASHED` | DuckDB Worker terminated unexpectedly |
| `E6002` | `WORKER_UNRESPONSIVE` | DuckDB Worker failed heartbeat, not accepting queries |
| `E6003` | `IPC_TIMEOUT` | Request timed out (30s default) |
| `E6006` | `SHUTTING_DOWN` | Application is shutting down, rejecting new queries |

---

### `query:cancel`

Cancel a running query. Stops both database execution and data transfer within 1 second.

| Property | Value |
|----------|-------|
| **Direction** | Renderer -> Main -> DuckDB Worker |
| **Pattern** | Request-Response (`ipcRenderer.invoke`) |
| **Data plane side-effect** | Worker stops sending Arrow batches; Renderer receives no further data for this queryId |

#### Request

```typescript
interface QueryCancelRequest {
  /** The queryId returned by query:execute */
  queryId: string;
}
```

#### Response

```typescript
// void -- resolves when cancellation is confirmed
```

#### Example

```typescript
await window.duckspace.query.cancel('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
```

#### Error Cases

| Code | Name | Condition |
|------|------|-----------|
| `E1003` | `QUERY_CANCELLED` | Query was already cancelled or completed |
| `E6003` | `IPC_TIMEOUT` | Cancellation request timed out |

---

### `query:status`

Query execution status update. Pushed from Main Process to Renderer when a query transitions state.

| Property | Value |
|----------|-------|
| **Direction** | Main -> Renderer (push) |
| **Pattern** | Push event (`webContents.send`) |
| **IPC event name** | `query:progress` |

#### Message

```typescript
interface QueryStatusEvent {
  /** Correlates with the queryId from query:execute */
  queryId: string;
  /** Current execution phase */
  phase: 'scanning' | 'filtering' | 'aggregating' | 'sorting' | 'streaming';
  /** Rows scanned so far (if available from DuckDB progress bar) */
  rowsScanned?: number;
  /** Rows after filter application */
  rowsFiltered?: number;
  /** Number of Arrow batches streamed to Renderer */
  batchesStreamed: number;
  /** Estimated total batches (null if unknown) */
  estimatedTotalBatches?: number;
  /** Milliseconds since query started */
  elapsedMs: number;
}
```

#### Example

```typescript
const unsub = window.duckspace.query.onStatus((status) => {
  console.log(`Query ${status.queryId}: ${status.phase}, ${status.batchesStreamed} batches`);
});
// Later: unsub() to stop listening
```

---

### `lifecycle:ready`

Renderer signals to Main Process that it has fully initialized: React hydration complete, Dexie.js open, MessagePort channels connected.

| Property | Value |
|----------|-------|
| **Direction** | Renderer -> Main |
| **Pattern** | Request-Response (`ipcRenderer.invoke`) |

#### Request

```typescript
// No payload
```

#### Response

```typescript
// void -- resolves when Main acknowledges
```

#### Example

```typescript
// Called once during Renderer bootstrap, after all initialization
await window.duckspace.lifecycle.ready();
```

#### Side Effects

- Main Process clears the dirty-shutdown marker
- Main Process transitions app state to "interactive"
- Main Process may show the main window (if using a splash screen)

#### Error Cases

| Code | Name | Condition |
|------|------|-----------|
| `E6003` | `IPC_TIMEOUT` | Main Process did not acknowledge within 30s |

---

### `lifecycle:shutdown`

Main Process notifies Renderer that graceful shutdown is beginning. The Renderer must flush Dexie.js writes, save UI state, and acknowledge.

| Property | Value |
|----------|-------|
| **Direction** | Main -> Renderer (push), then Renderer -> Main (ack) |
| **Pattern** | Push event (`webContents.send('shutdown-prepare')`) + Response (`ipcRenderer.invoke('lifecycle:shutdownAck')`) |

#### Push Message

```typescript
// No payload -- the event name 'shutdown-prepare' is the signal
```

#### Acknowledgment

```typescript
// Renderer calls after flushing state:
await window.duckspace.lifecycle.shutdownAck();
```

#### Sequence

```
1. Main sends 'shutdown-prepare' to Renderer
2. Renderer flushes Dexie.js pending writes
3. Renderer saves UI state (open tabs, scroll positions, active tab)
4. Renderer writes app_state['shutdown_status'] = 'clean'
5. Renderer calls lifecycle:shutdownAck
6. Main proceeds to shut down Workers
```

#### Example

```typescript
const unsub = window.duckspace.lifecycle.onShutdownPrepare(async () => {
  await flushDexieWrites();
  await saveUIState();
  await window.duckspace.lifecycle.shutdownAck();
});
```

#### Timeout

Main Process waits a maximum of 5 seconds for the shutdown acknowledgment. If the Renderer does not respond, Main proceeds with worker shutdown regardless.

---

### `lifecycle:health`

Health check request/response for worker processes. The Main Process periodically pings the DuckDB Worker and pushes health status updates to the Renderer.

| Property | Value |
|----------|-------|
| **Direction (Worker check)** | Main -> DuckDB Worker -> Main |
| **Direction (Status push)** | Main -> Renderer (push event: `worker:status`) |
| **Frequency** | Every 60 seconds (configurable via `config.json`) |

#### Worker Heartbeat Request (Main -> Worker via `parentPort`)

```typescript
interface HeartbeatRequest {
  type: 'heartbeat';
  /** Monotonic timestamp for latency measurement */
  sentAt: number;
}
```

#### Worker Heartbeat Response (Worker -> Main via `parentPort`)

```typescript
interface HeartbeatAck {
  type: 'heartbeat_ack';
  /** Echo back the sentAt timestamp */
  sentAt: number;
  /** Worker's self-reported health */
  status: 'healthy' | 'degraded' | 'busy';
  /** Optional diagnostics */
  details?: {
    activeQueries?: number;
    memoryUsageMB?: number;
    uptime?: number;
  };
}
```

#### Renderer Push Event

```typescript
interface WorkerHealthEvent {
  /** Worker identifier ('duckdb' in Phase 1) */
  worker: 'duckdb';
  /** Derived health status */
  status: 'ready' | 'busy' | 'degraded' | 'restarting' | 'failed';
  /** Number of automatic restarts since app launch */
  restartCount?: number;
  /** Human-readable status message */
  message?: string;
}
```

#### Example

```typescript
const unsub = window.duckspace.lifecycle.onWorkerHealth((health) => {
  if (health.status === 'degraded') {
    showWarningBanner('Database engine is experiencing issues');
  }
});
```

#### Health Check Rules

| Condition | Result |
|-----------|--------|
| Heartbeat ACK received within 5 seconds | Status remains `ready` or `busy` (depending on `activeQueries`) |
| Heartbeat ACK not received within 5 seconds (1 miss) | No status change; retry on next interval |
| Two consecutive missed heartbeats | Worker marked `degraded`; auto-restart initiated |
| Worker restarts successfully | Status returns to `ready` |
| Three restarts within 60 seconds | Worker marked `failed`; user notified |

---

### `query:listTables`

List all registered tables and views in DuckDB's catalog.

| Property | Value |
|----------|-------|
| **Direction** | Renderer -> Main -> DuckDB Worker |
| **Pattern** | Request-Response (`ipcRenderer.invoke`) |

#### Request

```typescript
// No payload
```

#### Response

```typescript
interface CatalogListResponse {
  entries: CatalogEntry[];
}

interface CatalogEntry {
  /** UUID identifier */
  id: string;
  /** DuckDB table/view name */
  name: string;
  /** DuckDB schema (always 'main' in Phase 1) */
  schema: string;
  /** 'table' for persistent tables, 'view' for SQL views */
  type: 'table' | 'view';
  /** Number of columns */
  columnCount: number;
  /** Estimated row count */
  rowCount: number;
  /** Estimated storage size in bytes */
  sizeBytes: number;
  /** Current status */
  status: 'active' | 'removed' | 'error';
  /** ISO timestamp of registration */
  registeredAt: string;
}
```

#### Example

```typescript
const entries = await window.duckspace.catalog.listTables();
// [
//   {
//     id: "src-001", name: "sales", schema: "main", type: "table",
//     columnCount: 8, rowCount: 1000000, sizeBytes: 48000000,
//     status: "active", registeredAt: "2026-02-05T10:00:00.000Z"
//   },
//   {
//     id: "src-002", name: "products", schema: "main", type: "table",
//     columnCount: 5, rowCount: 500, sizeBytes: 24000,
//     status: "active", registeredAt: "2026-02-05T10:00:00.000Z"
//   }
// ]
```

#### Error Cases

| Code | Name | Condition |
|------|------|-----------|
| `E6001` | `WORKER_CRASHED` | DuckDB Worker not available |
| `E6003` | `IPC_TIMEOUT` | Request timed out |

---

### `query:describeTable`

Get detailed column schema for a specific table.

| Property | Value |
|----------|-------|
| **Direction** | Renderer -> Main -> DuckDB Worker |
| **Pattern** | Request-Response (`ipcRenderer.invoke`) |

#### Request

```typescript
interface CatalogDescribeRequest {
  /** DuckDB table or view name */
  tableName: string;
}
```

#### Response

```typescript
interface CatalogDescribeResponse {
  /** Table name */
  tableName: string;
  /** DuckDB schema */
  schemaName: string;
  /** Column definitions */
  columns: ColumnSchema[];
  /** Estimated row count */
  rowCount: number;
  /** Estimated storage size */
  sizeBytes: number;
}

interface ColumnSchema {
  /** Column name */
  name: string;
  /** DuckDB type (e.g., VARCHAR, INTEGER, DECIMAL(10,2), TIMESTAMP) */
  duckdbType: string;
  /** Arrow type equivalent (e.g., Utf8, Int32, Float64, Timestamp(us, UTC)) */
  arrowType: string;
  /** Whether column allows NULL values */
  nullable: boolean;
  /** 0-based position in the table */
  ordinalPosition: number;
}
```

#### Example

```typescript
const schema = await window.duckspace.catalog.describeTable('sales');
// {
//   tableName: "sales",
//   schemaName: "main",
//   columns: [
//     { name: "id", duckdbType: "INTEGER", arrowType: "Int32", nullable: false, ordinalPosition: 0 },
//     { name: "region", duckdbType: "VARCHAR", arrowType: "Utf8", nullable: false, ordinalPosition: 1 },
//     { name: "amount", duckdbType: "DOUBLE", arrowType: "Float64", nullable: true, ordinalPosition: 2 },
//     { name: "sale_date", duckdbType: "DATE", arrowType: "Date32", nullable: false, ordinalPosition: 3 },
//   ],
//   rowCount: 1000000,
//   sizeBytes: 48000000
// }
```

#### Error Cases

| Code | Name | Condition |
|------|------|-----------|
| `E1004` | `TABLE_NOT_FOUND` | Table does not exist in DuckDB |
| `E6001` | `WORKER_CRASHED` | DuckDB Worker not available |
| `E6003` | `IPC_TIMEOUT` | Request timed out |

---

### `catalog:preview`

Get sample rows from a table without executing a full table scan. Implemented as `SELECT * FROM <table> LIMIT <n>` internally.

| Property | Value |
|----------|-------|
| **Direction** | Renderer -> Main -> DuckDB Worker |
| **Pattern** | Request-Response (`ipcRenderer.invoke`) returning a `QueryHandle` |
| **Data plane side-effect** | Arrow IPC results stream via `duckdb-data` MessagePort |

#### Request

```typescript
interface CatalogPreviewRequest {
  /** DuckDB table or view name */
  tableName: string;
  /** Number of sample rows (default: 100) */
  limit?: number;
}
```

#### Response

```typescript
interface CatalogPreviewResponse {
  /** Query ID for receiving data on the MessagePort */
  queryId: string;
}
```

#### Example

```typescript
const { queryId } = await window.duckspace.catalog.previewTable('sales', 50);
// Arrow batches for the first 50 rows arrive on duckdb-data MessagePort
```

#### Error Cases

| Code | Name | Condition |
|------|------|-----------|
| `E1004` | `TABLE_NOT_FOUND` | Table does not exist |
| `E6001` | `WORKER_CRASHED` | DuckDB Worker not available |

---

## Data Plane Channel

### `duckdb-data` MessagePort

Direct Worker-to-Renderer channel for Arrow IPC data transfer. Established during startup by the `MessagePortOrchestrator`.

| Property | Value |
|----------|-------|
| **Direction** | DuckDB Worker <-> Renderer (bidirectional) |
| **Protocol** | `MessagePort` via `MessageChannelMain` |
| **Format** | Arrow IPC `ArrayBuffer` with JSON envelope |
| **Transfer** | `ArrayBuffer` in `transferList` (zero-copy ownership move) |

#### Setup Sequence

```
1. Main Process creates MessageChannelMain -> port1 + port2
2. Main sends port1 to DuckDB Worker: worker.postMessage({ type: 'port', channel: 'duckdb-data' }, [port1])
3. Main sends port2 to Renderer: webContents.postMessage('port', { channel: 'duckdb-data' }, [port2])
4. Worker confirms: parentPort.postMessage({ type: 'port-ready', channel: 'duckdb-data' })
5. Renderer stores port in MessagePortManager
```

#### Message Types (Worker -> Renderer)

##### Arrow Batch

```typescript
interface ArrowBatchMessage {
  type: 'arrow-batch';
  /** Correlates with QueryExecuteResponse.queryId */
  queryId: string;
  /** 0-based batch sequence number */
  index: number;
  /** Total batch count (if known; null for streaming) */
  totalBatches?: number;
  /** Number of rows in this batch */
  rowCount: number;
  /** Size of the Arrow IPC buffer in bytes */
  byteSize: number;
}
// postMessage(envelope, [arrowBuffer])
// arrowBuffer: ArrayBuffer containing Arrow IPC Stream data
// First batch includes the Arrow schema in the IPC stream header
```

##### Stream End

```typescript
interface StreamEndMessage {
  type: 'arrow-end';
  /** Correlates with the original queryId */
  queryId: string;
  /** Final count of batches sent */
  totalBatches: number;
  /** Total rows across all batches */
  totalRows: number;
  /** Total bytes transferred */
  totalBytes: number;
  /** Query + transfer duration in milliseconds */
  durationMs: number;
}
```

##### Query Error (via data plane)

```typescript
interface DataPlaneError {
  type: 'arrow-error';
  /** Correlates with the original queryId */
  queryId: string;
  /** Error code from taxonomy (E1xxx-E9xxx) */
  code: string;
  /** Human-readable error description */
  message: string;
  /** Number of batches already sent before error */
  batchesSent: number;
}
```

#### Message Types (Renderer -> Worker)

##### Backpressure ACK

```typescript
interface BatchAckMessage {
  type: 'ack';
  /** Correlates with ArrowBatchMessage.queryId */
  queryId: string;
  /** Batch index being acknowledged */
  index: number;
}
```

##### Cancel (via data plane)

```typescript
interface DataPlaneCancelMessage {
  type: 'cancel';
  /** The queryId to cancel */
  queryId: string;
  /** Cancellation reason */
  reason?: 'user_cancelled' | 'component_unmounted' | 'timeout' | 'superseded';
}
```

#### Backpressure Protocol

The data plane uses **window-based flow control** to prevent the DuckDB Worker from overwhelming the Renderer:

```
Window size: 4 batches (~8 MB in-flight with ~2 MB target batch size)

1. Worker sends batch 0, 1, 2, 3 (fills window)
2. Worker PAUSES -- waits for ACK
3. Renderer processes batch 0, sends ACK { index: 0 }
4. Worker sends batch 4 (window slides)
5. Renderer processes batch 1, sends ACK { index: 1 }
6. Worker sends batch 5 (window slides)
... continues until stream end
```

| Parameter | Value | Notes |
|-----------|-------|-------|
| Window size | 4 batches | Configurable; 4 is the default |
| Target batch size | ~2 MB | Adaptive based on row width |
| Max in-flight data | ~8 MB | Window size x batch size |
| ACK timeout | 10 seconds | If no ACK within 10s, Worker pauses and reports stall |

#### Arrow Batch Format

Each `ArrayBuffer` contains an Arrow IPC Stream:

```
[Schema message (first batch only)]
[RecordBatch message]
[RecordBatch message]
...
```

The Renderer deserializes using Flechette:

```typescript
import { tableFromIPC } from '@uwdata/flechette';

port.onmessage = (event) => {
  const { data } = event;
  if (data.type === 'arrow-batch') {
    const arrowBuffer: ArrayBuffer = event.ports?.[0] ?? event.data.__arrowBuffer;
    const table = tableFromIPC(arrowBuffer);
    // table.numRows, table.numCols, table.getChild('column_name')
  }
};
```

**Note on transfer**: The `ArrayBuffer` is in the `transferList` of `postMessage()`, meaning ownership is **moved** to the Renderer. After transfer, the Worker can no longer access that buffer. This is zero-copy -- no serialization or deserialization of the binary data occurs.

---

## Worker Control Messages (Main <-> DuckDB Worker)

These messages flow over `parentPort` / `worker.postMessage()` between the Main Process and the DuckDB Worker. They are internal to the control plane and not exposed to the Renderer.

### Query Dispatch

```typescript
/** Main -> DuckDB Worker: Execute SQL query */
interface WorkerQueryRequest {
  type: 'execute_query';
  /** UUID assigned by QueryRouter */
  queryId: string;
  /** Parameterized SQL with $1, $2, ... placeholders */
  sql: string;
  /** Parameter values for binding */
  params?: unknown[];
  /** Execution options */
  options?: {
    /** Query timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Override default batch size */
    batchSize?: number;
    /** Whether this is a read-only query (default: true) */
    readOnly?: boolean;
  };
}
```

### Query Cancel (Control Plane)

```typescript
/** Main -> DuckDB Worker: Cancel a running query */
interface WorkerCancelRequest {
  type: 'cancel_query';
  queryId: string;
}
```

### Catalog Operations

```typescript
/** Main -> DuckDB Worker: Get table information */
interface WorkerGetTableInfoRequest {
  type: 'get_table_info';
  tableName: string;
}

/** DuckDB Worker -> Main: Table info response */
interface WorkerGetTableInfoResponse {
  type: 'table_info';
  tableName: string;
  columns: ColumnSchema[];
  rowCount: number;
  sizeBytes: number;
}

/** DuckDB Worker -> Main: Catalog update after table registration */
interface WorkerCatalogUpdate {
  type: 'catalog_update';
  table: string;
  columns: ColumnSchema[];
  rowCount: number;
  sizeBytes: number;
  sourceId: string;
  registrationType: 'table' | 'view';
}
```

### Worker Lifecycle

```typescript
/** Worker -> Main: Initialization complete */
interface WorkerReadyMessage {
  type: 'ready';
  worker: 'duckdb';
  metadata?: {
    duckdbVersion?: string;
    extensionsLoaded?: string[];
    tableCount?: number;
  };
}

/** Main -> Worker: Request graceful shutdown */
interface ShutdownRequest {
  type: 'shutdown';
}

/** Worker -> Main: Shutdown complete */
interface ShutdownComplete {
  type: 'shutdown-complete';
  worker: 'duckdb';
}
```

### Configuration Update

```typescript
/** Main -> DuckDB Worker: Update runtime configuration */
interface WorkerConfigUpdate {
  type: 'configure';
  settings: {
    memory_limit?: string;
    threads?: number;
    temp_directory?: string;
  };
}
```

### Health Check

```typescript
/** Main -> DuckDB Worker: Health check */
interface WorkerHealthCheck {
  type: 'health_check';
}

/** DuckDB Worker -> Main: Health check response */
interface WorkerHealthResponse {
  type: 'health_check_result';
  status: 'healthy' | 'degraded' | 'failed';
  tables: number;
  memoryUsedMB: number;
  activeQueries: number;
}
```

---

## Error Response Format

All IPC errors (both control-plane rejections and data-plane error messages) follow a consistent format:

```typescript
interface IPCError {
  /** Structured error code (E1xxx-E9xxx) */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Whether the client should retry this operation */
  retryable: boolean;
  /** Suggested retry delay in milliseconds (present if retryable) */
  retryAfterMs?: number;
  /** Additional context for debugging */
  details?: Record<string, unknown>;
  /** Stack trace (development mode only) */
  stack?: string;
}
```

### Phase 1 Error Codes

| Code | Name | Category | Retryable |
|------|------|----------|-----------|
| `E1001` | `QUERY_SYNTAX_ERROR` | Database | No |
| `E1002` | `QUERY_TIMEOUT` | Database | Yes |
| `E1003` | `QUERY_CANCELLED` | Database | No |
| `E1004` | `TABLE_NOT_FOUND` | Database | No |
| `E1005` | `COLUMN_NOT_FOUND` | Database | No |
| `E1006` | `TYPE_MISMATCH` | Database | No |
| `E1007` | `OUT_OF_MEMORY` | Database | Yes (reduced scope) |
| `E1008` | `DISK_FULL` | Database | No |
| `E1010` | `DATABASE_CORRUPT` | Database | No |
| `E1012` | `MUTATION_REJECTED` | Database | No |
| `E6001` | `WORKER_CRASHED` | System | Yes (auto-restart) |
| `E6002` | `WORKER_UNRESPONSIVE` | System | Yes (restart) |
| `E6003` | `IPC_TIMEOUT` | System | Yes |
| `E6004` | `PORT_DISCONNECTED` | System | Yes (recreate) |
| `E6005` | `MEMORY_PRESSURE` | System | Yes (after eviction) |
| `E6006` | `SHUTTING_DOWN` | System | No |

---

## Channel Registry (Phase 1)

Complete listing of all IPC channels registered in Phase 1:

| Channel | Protocol | Direction | Handler | Request | Response |
|---------|----------|-----------|---------|---------|----------|
| `query:execute` | `ipcMain.handle` | R -> M | QueryRouter | `{ sql, params? }` | `{ queryId }` |
| `query:cancel` | `ipcMain.handle` | R -> M | QueryRouter | `{ queryId }` | `void` |
| `query:listTables` | `ipcMain.handle` | R -> M | QueryRouter | (none) | `CatalogEntry[]` |
| `query:describeTable` | `ipcMain.handle` | R -> M | QueryRouter | `{ tableName }` | `CatalogDescribeResponse` |
| `catalog:preview` | `ipcMain.handle` | R -> M | QueryRouter | `{ tableName, limit? }` | `{ queryId }` |
| `lifecycle:ready` | `ipcMain.handle` | R -> M | AppLifecycleManager | (none) | `void` |
| `lifecycle:getAppState` | `ipcMain.handle` | R -> M | AppLifecycleManager | (none) | `AppState` |
| `lifecycle:shutdownAck` | `ipcMain.handle` | R -> M | AppLifecycleManager | (none) | `void` |
| `config:get` | `ipcMain.handle` | R -> M | ConfigManager | `{ key }` | `T` |
| `config:set` | `ipcMain.handle` | R -> M | ConfigManager | `{ key, value }` | `void` |
| `config:getAll` | `ipcMain.handle` | R -> M | ConfigManager | (none) | `Record<string, unknown>` |
| `query:progress` | `webContents.send` | M -> R | (push) | -- | `QueryStatusEvent` |
| `worker:status` | `webContents.send` | M -> R | (push) | -- | `WorkerHealthEvent` |
| `shutdown-prepare` | `webContents.send` | M -> R | (push) | -- | (none) |
| `port` | `webContents.postMessage` | M -> R | (setup) | -- | MessagePort handle |
| `duckdb-data` | `MessagePort` | W <-> R | (data plane) | -- | Arrow IPC |

Legend: R = Renderer, M = Main Process, W = DuckDB Worker

---

## Timeout Policy (Phase 1)

| Channel Type | Default Timeout | Maximum | Override |
|-------------|----------------|---------|---------|
| `ipcMain.handle()` control messages | 30 seconds | 120 seconds | Per-request via `options.timeout` |
| Worker `postMessage()` commands | 30 seconds | 60 seconds | Per-command |
| MessagePort data batch ACK | 10 seconds | 60 seconds | Via backpressure config |
| Heartbeat response | 5 seconds | 5 seconds | Not configurable |
| Shutdown acknowledgment | 5 seconds | 5 seconds | Not configurable |

---

*IPC Channels contract for the Electron Foundation (Phase 1) feature specification.*
