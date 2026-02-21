# Data Plane Message Contracts: Local Data Ingestion

**Feature**: 002-local-data-ingestion
**Date**: 2026-02-07

---

## Data Plane Overview

The existing data plane (MessagePort with Arrow IPC buffers and ACK-based backpressure) is **unchanged** for Phase 2. File ingestion does NOT flow through the data plane — ingestion uses `CREATE TABLE AS` in the Worker, which is a DuckDB-internal operation with no data transfer to the Renderer.

The data plane is used when the user **views** imported data in the grid:

```
User clicks table    Renderer sends       Worker executes         Arrow IPC batches
in catalog      →    previewTable()   →   SELECT * FROM table  →  via MessagePort
                     (existing API)       + to_arrow_ipc()        (existing pipeline)
                                                                        │
                                                                        ▼
                                                                  Perspective.js
                                                                  WASM engine
                                                                  (NEW consumer)
```

---

## Perspective.js Integration with Data Plane

### Arrow IPC Buffer Routing

When the Renderer receives Arrow IPC batches via the MessagePort data channel, the buffer now has two consumers:

1. **Perspective.js** — for the data grid (primary consumer for grid tabs)
2. **Flechette** — for metadata extraction (column names, types, row counts)

The routing decision is based on the active tab type:

```typescript
// In Renderer data-plane handler:
function onArrowBatch(batch: ArrowBatchMessage): void {
  const buffer = batch.buffer; // ArrayBuffer from MessagePort

  if (activeTab.type === 'data_grid') {
    // Route to Perspective WASM engine
    perspectiveTable.update(buffer);
  } else if (activeTab.type === 'query') {
    // Route to existing flechette decode pipeline
    decodeBatch(buffer);
  }

  // Always send ACK for backpressure
  sendAck(batch.queryId, batch.index);
}
```

### Perspective Table Lifecycle

```typescript
// Create Perspective table from first batch (contains Arrow schema)
const perspectiveWorker = await perspective.worker();
const table = await perspectiveWorker.table(firstBatchBuffer);

// Subsequent batches append data
for (const batch of subsequentBatches) {
  table.update(batch.buffer);
}

// When tab closes, clean up
await table.delete();
```

---

## No New Data Plane Message Types

Phase 2 does not add new data-plane message types. The existing messages are sufficient:

| Message | Direction | Usage in Phase 2 |
|---------|-----------|-------------------|
| `ArrowBatchMessage` | Worker → Renderer | Grid data viewing (SELECT queries) |
| `StreamEndMessage` | Worker → Renderer | Marks end of query result stream |
| `DataPlaneError` | Worker → Renderer | Query errors during grid viewing |
| `BatchAckMessage` | Renderer → Worker | Backpressure ACK (unchanged) |
| `DataPlaneCancelMessage` | Renderer → Worker | Cancel active grid data stream |

---

## Ingestion Data Flow (NOT Data Plane)

File ingestion is a Worker-internal operation. Data does NOT flow through the MessagePort:

```
Main Process                  DuckDB Worker
────────────                  ─────────────
ingest_file request    →      CREATE TABLE "name" AS
(via worker_threads             SELECT * FROM read_csv('/path')
 parentPort)
                              [DuckDB reads file internally,
                               materializes to columnar storage]

                       ←      ingest_file_progress (rows, bytes)
                       ←      ingest_file_complete (row count, columns)
```

Progress messages flow via the Worker `parentPort` (control plane), NOT the data-plane MessagePort. This keeps the data plane clear for user queries.

---

## Backpressure Considerations for Large Grid Views

When viewing a 10M-row table in the grid, the existing backpressure mechanism applies:

- **Window size**: 4 batches in flight
- **Target batch size**: ~2 MB per Arrow IPC batch
- **Max in-flight**: ~8 MB
- **ACK timeout**: 10,000 ms

However, with Perspective.js, the data flow changes slightly:

1. Initial query (`SELECT * FROM table LIMIT N`) sends enough rows to fill the Perspective table
2. Perspective's WASM engine handles all subsequent sort/filter/aggregate operations locally
3. For tables larger than Perspective's in-memory capacity, we use `CREATE VIEW` and query with `LIMIT` + `OFFSET` (or DuckDB-side filtering)

**Design decision**: For Phase 2, load up to 1M rows into Perspective on first click. Larger tables show a "Load more" affordance or use DuckDB-side pagination. This keeps Renderer memory bounded while enabling fast local sort/filter in the WASM engine.
