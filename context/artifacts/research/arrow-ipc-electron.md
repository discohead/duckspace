# Research Finding: Apache Arrow IPC in Electron

**Task ID:** research-arrow-ipc-electron
**Date:** 2026-02-04
**Domain:** System Design - duckspace
**Status:** Complete

---

## Executive Summary

This document evaluates Apache Arrow IPC mechanisms for zero-copy data transfer within a duckspace Electron application. The analysis covers Arrow JS APIs, Electron process transfer semantics, DuckDB interoperability, predicate pushdown, streaming, and memory layout considerations. The conclusion is that **ArrayBuffer transfer via Electron's `MessagePort` with Arrow IPC stream format** is the optimal primary mechanism, supplemented by `SharedArrayBuffer` for high-frequency, read-only data sharing where security constraints allow.

---

## 1. Arrow JS Library (apache-arrow npm package)

### 1.1 RecordBatch and Table APIs

The `apache-arrow` npm package (currently v17.x) provides full Arrow columnar format support in JavaScript/TypeScript:

- **`RecordBatch`**: The fundamental unit of columnar data. Contains a `Schema` and a set of equal-length column arrays (`Vector` instances). Each `RecordBatch` maps to contiguous memory buffers. This is the natural unit for IPC transfer.
- **`Table`**: A logical collection of `RecordBatch` instances sharing the same schema. Tables are lazy views over batches -- they do not copy data when concatenated. This aligns with the "stream and scan" principle since you can process batch-by-batch.
- **`Vector`**: Typed column accessor backed by one or more `ArrayBuffer` instances. Vectors use Arrow's validity bitmap, offsets buffer, and data buffer layout.
- **`Schema`**: Metadata describing column names, types, and nullable flags. Transmitted once per IPC stream as a header.

**Key API surface for IPC:**
```typescript
import { tableToIPC, tableFromIPC, RecordBatchStreamWriter, RecordBatchStreamReader } from 'apache-arrow';

// Serialize Table -> Arrow IPC buffer
const ipcBuffer: Uint8Array = tableToIPC(table, 'stream'); // or 'file'

// Deserialize Arrow IPC buffer -> Table
const table: Table = tableFromIPC(ipcBuffer);
```

### 1.2 IPC Stream Format vs File Format

Arrow defines two IPC serialization formats:

| Aspect | Stream Format | File Format |
|--------|---------------|-------------|
| Layout | Schema message + N RecordBatch messages + EOS | Magic + Schema + N RecordBatch + Footer + Magic |
| Random access | No (sequential only) | Yes (footer contains block offsets) |
| Streaming | Yes (can emit/consume incrementally) | No (footer required at end) |
| Use case | IPC between processes, network transfer | Persistent storage, memory-mapped files |
| Overhead | Minimal (4-byte continuation + flatbuffer metadata per batch) | Slightly higher (footer, magic bytes) |

**Recommendation for Electron IPC:** Use **Stream format** for process-to-process transfer. It supports chunked/streaming reads, has lower overhead, and aligns with the stream-and-scan principle. File format is only needed if persisting Arrow data to disk for memory-mapped access.

### 1.3 Memory Management (ArrayBuffer Ownership)

Arrow JS stores all columnar data in `ArrayBuffer` instances:

- Each `Vector` holds references to one or more `ArrayBuffer` objects (validity bitmap, offsets, data)
- A `RecordBatch` typically backs all its columns with a shared set of `ArrayBuffer` instances
- `tableToIPC()` produces a single `Uint8Array` whose `.buffer` is an `ArrayBuffer` containing the entire IPC payload

**Ownership semantics are critical for IPC:**
- When an `ArrayBuffer` is **transferred** via `postMessage`, the sending context loses access (the buffer is "neutered" / becomes zero-length)
- The receiving context gets ownership of the exact memory -- no copy occurs
- This is "move semantics," not true shared memory, but it is zero-copy in the transfer itself

---

## 2. Zero-Copy Transfer Mechanisms in Electron

Electron has three process types relevant to duckspace:
- **Main Process** (Node.js): owns DuckDB, LanceDB, RxDB
- **Renderer Process** (Chromium): owns visualization (Perspective.js, Observable Plot, ECharts)
- **Worker Threads** (Node.js workers in main): isolate heavy computation

### 2.1 SharedArrayBuffer Between Processes

`SharedArrayBuffer` enables true zero-copy shared memory -- multiple contexts read/write the same physical memory pages.

**Status in Electron (2025-2026):**
- `SharedArrayBuffer` requires **cross-origin isolation** (COOP/COEP headers)
- Electron supports this via `webPreferences.crossOriginIsolated: true` on `BrowserWindow`
- Between Main and Renderer: `SharedArrayBuffer` can be sent via `postMessage` but requires COOP/COEP enforcement
- Between Main and Worker Threads (Node.js `worker_threads`): fully supported with no restrictions
- Between Renderer and Renderer: requires cross-origin isolation on both

**Security restrictions:**
- Spectre/Meltdown mitigations mean `SharedArrayBuffer` requires opt-in isolation
- Enabling COOP/COEP can break third-party resources (fonts, scripts loaded without CORS)
- For a local desktop app like duckspace with no third-party web content, this is manageable

**Concurrency concerns:**
- `SharedArrayBuffer` requires careful synchronization (Atomics, Mutex)
- Arrow buffers are **immutable after creation** -- this is a perfect fit for shared memory (readers don't need locks if the writer publishes a complete buffer before sharing)
- Pattern: Main process writes Arrow IPC into a `SharedArrayBuffer`, signals Renderer, Renderer reads. No concurrent mutation. No locks needed.

### 2.2 MessagePort with Transferable Objects

Electron's `MessageChannelMain` creates direct `MessagePort` pairs between any two processes:

```typescript
// Main process
const { port1, port2 } = new MessageChannelMain();
mainWindow.webContents.postMessage('port', null, [port2]);
// port1 stays in main, port2 goes to renderer
```

**Transferable objects supported:**
- `ArrayBuffer` (neutered on send, zero-copy transfer)
- `MessagePort` (can be forwarded)
- `ReadableStream`, `WritableStream` (Chromium 108+)
- `OffscreenCanvas` (not relevant here)

**This is the primary IPC mechanism for Arrow data.** When you call:
```typescript
port1.postMessage({ type: 'query-result', data: arrowIpcBuffer.buffer }, [arrowIpcBuffer.buffer]);
```
The `ArrayBuffer` is transferred (moved) to the receiver with no memory copy.

### 2.3 ArrayBuffer Transfer Semantics

Clarifying the terminology:

| Mechanism | Copy? | Shared? | Sender retains access? |
|-----------|-------|---------|------------------------|
| `postMessage` (no transfer list) | YES (structured clone) | No | Yes |
| `postMessage` with transfer list | NO (zero-copy move) | No | No (buffer neutered) |
| `SharedArrayBuffer` via `postMessage` | NO (shares memory) | Yes | Yes |

**"Zero-copy" in this document means:** the Arrow IPC `ArrayBuffer` is moved or shared without copying the payload bytes. Both `ArrayBuffer` transfer and `SharedArrayBuffer` sharing achieve this.

### 2.4 Actual Zero-Copy Feasibility

True zero-copy requires that the data bytes are never copied from producer to consumer. In the duckspace pipeline:

1. **DuckDB produces Arrow buffers** in native (C++) memory
2. **DuckDB Node.js binding** exposes these as `ArrayBuffer` (or copies into JS-managed `ArrayBuffer`)
3. **Main process** transfers `ArrayBuffer` to Renderer via `MessagePort`
4. **Renderer** wraps the `ArrayBuffer` in Arrow JS `Table`/`RecordBatch`
5. **Visualization library** consumes the Arrow data

Steps 3-4-5 are zero-copy (transfer + wrap). Step 2 depends on the DuckDB Node.js binding implementation -- see Section 3.

---

## 3. DuckDB Arrow Output -> Arrow JS Interop

### 3.1 DuckDB's Arrow Result Format

DuckDB natively produces Arrow-format results via its C API:

- `duckdb_query_arrow()` returns an Arrow result set
- Results are available as Arrow `RecordBatch` streams
- The DuckDB Node.js binding (`@duckdb/node-bindings` or `duckdb-async`) can expose results as Arrow IPC buffers

**DuckDB Node.js binding (duckdb-node-neo / @duckdb/node-bindings):**
- The newer binding provides `arrowIPCStream()` which returns Arrow IPC stream format directly
- Each chunk is a `Uint8Array` containing one or more Arrow IPC record batches
- These buffers can be directly passed to `tableFromIPC()` in `apache-arrow`

```typescript
// DuckDB -> Arrow IPC -> Arrow JS (conceptual)
const stmt = await connection.prepare('SELECT * FROM large_table WHERE region = ?');
const result = await stmt.run('US');
const ipcStream = await result.arrowIPCStream();

for await (const chunk of ipcStream) {
  // chunk is Uint8Array containing Arrow IPC data
  // Transfer chunk.buffer to Renderer via MessagePort
  port.postMessage({ data: chunk.buffer }, [chunk.buffer]);
}
```

### 3.2 Direct Consumption Without Serialization

The ideal path avoids all serialization:

```
DuckDB (C++ engine)
  -> Arrow C Data Interface (zero-copy pointer handoff)
    -> Node.js ArrayBuffer (backed by same memory or one copy)
      -> MessagePort transfer (zero-copy move)
        -> Arrow JS tableFromIPC() (zero-copy wrap)
          -> Perspective.js / visualization (zero-copy columnar access)
```

**Current reality (2025-2026):**
- DuckDB's Node.js binding performs one copy when converting from C++ Arrow to Node.js `ArrayBuffer` (crossing the native/JS boundary requires V8-managed memory)
- This single copy is unavoidable without `SharedArrayBuffer`-based native addons
- After that single copy, all subsequent transfers within Electron are zero-copy

**Optimization path (if needed):**
- Use a native addon that allocates `SharedArrayBuffer` and has DuckDB write directly into it
- This eliminates the native-to-JS copy but adds significant complexity
- Not recommended for initial design; premature optimization for datasets under ~100MB

---

## 4. Predicate Pushdown Over IPC

### 4.1 Sending Query Predicates to Main Process

Since Main Process owns DuckDB (per process isolation principle), the Renderer must request data by sending queries or query descriptors:

**Pattern: Query descriptor over IPC**
```typescript
// Renderer -> Main (request)
port.postMessage({
  type: 'query',
  sql: 'SELECT region, SUM(revenue) FROM sales WHERE year = ? GROUP BY region',
  params: [2025],
  options: { batchSize: 65536, streaming: true }
});

// Main -> Renderer (response, streamed)
// Arrow IPC batches transferred one at a time
```

**Query descriptor (structured, non-SQL) alternative:**
```typescript
port.postMessage({
  type: 'query',
  source: 'sales',
  columns: ['region', 'revenue'],
  filters: [{ column: 'year', op: '=', value: 2025 }],
  aggregations: [{ column: 'revenue', fn: 'SUM' }],
  groupBy: ['region'],
  options: { batchSize: 65536 }
});
```

The structured query descriptor is safer (prevents SQL injection from plugin code) and enables the Main process to optimize query plans, but SQL is more flexible. **Recommendation: support both**, with structured descriptors for UI-driven queries and parameterized SQL for advanced/AI-generated queries.

### 4.2 Filtering at Source vs After Transfer

| Strategy | When to Use | Rationale |
|----------|-------------|-----------|
| **Filter at DuckDB (pushdown)** | Always, as the default | DuckDB is faster at filtering (columnar scans, SIMD), reduces data transferred over IPC, respects stream-and-scan principle |
| **Filter in Renderer** | Interactive cross-filtering on already-loaded data | When a small result set is already in Renderer memory (e.g., aggregated data for a chart), additional client-side filtering avoids IPC round-trip |
| **Hybrid** | Dashboard with shared base query | Main query with base filters at DuckDB, fine-grained interactive filters client-side on the (smaller) result set |

**Key principle:** Never transfer raw data and filter in the Renderer. Always push predicates to DuckDB. The Renderer should only hold data that will be rendered, and that data should already be filtered and aggregated.

---

## 5. Streaming Arrow Data Over IPC

### 5.1 Chunked Transfer for Large Result Sets

Large queries (millions of rows) must be streamed batch-by-batch:

```typescript
// Main process: stream Arrow batches
async function streamQueryResults(port: MessagePort, sql: string, params: any[]) {
  const connection = await db.connect();
  const result = await connection.runAndReadAll(sql, params); // or streaming variant
  const ipcStream = result.arrowIPCStream({ batchSize: 65536 });

  let batchIndex = 0;
  for await (const chunk of ipcStream) {
    port.postMessage(
      { type: 'arrow-batch', index: batchIndex, data: chunk.buffer },
      [chunk.buffer] // transfer, zero-copy
    );
    batchIndex++;
  }

  port.postMessage({ type: 'arrow-end', totalBatches: batchIndex });
}
```

**Batch size selection:**
- 65,536 rows per batch is Arrow's conventional default (2^16)
- For wide tables (many columns), reduce batch count to keep per-batch memory ~1-4MB
- For narrow tables, larger batches (131,072 or 262,144 rows) reduce per-batch overhead
- Configurable per query based on schema width

### 5.2 Backpressure Handling

Electron's `MessagePort` does not natively support backpressure -- messages queue in the receiver's event loop. For large streams, this can overwhelm the Renderer.

**Backpressure strategies:**

1. **Acknowledgment-based flow control (recommended):**
```typescript
// Main sends batch, waits for ACK before sending next
port.postMessage({ type: 'arrow-batch', index: 0, data: buffer }, [buffer]);

port.on('message', (msg) => {
  if (msg.type === 'ack' && msg.index === currentBatch) {
    sendNextBatch();
  }
});
```

2. **Window-based flow control:**
```typescript
// Allow N batches in-flight before requiring ACKs
const WINDOW_SIZE = 4;
let inFlight = 0;

function maybeSendNext() {
  while (inFlight < WINDOW_SIZE && hasMoreBatches()) {
    sendBatch(nextBatch());
    inFlight++;
  }
}

port.on('message', (msg) => {
  if (msg.type === 'ack') {
    inFlight--;
    maybeSendNext();
  }
});
```

3. **TransformStream / ReadableStream transfer (modern):**
   Chromium 108+ supports transferring `ReadableStream` objects via `postMessage`. This provides built-in backpressure:
```typescript
const { readable, writable } = new TransformStream();
port.postMessage({ type: 'arrow-stream', stream: readable }, [readable]);

const writer = writable.getWriter();
for await (const chunk of ipcStream) {
  await writer.write(chunk); // backpressure: awaits if reader is slow
}
await writer.close();
```

**Recommendation:** Use window-based flow control for initial implementation (simple, reliable). Evaluate `ReadableStream` transfer for future optimization once Electron's support stabilizes.

---

## 6. Arrow Flight vs Custom IPC

### 6.1 Arrow Flight RPC Applicability

Arrow Flight is an RPC framework built on gRPC that uses Arrow IPC format for data transfer. It provides:
- `GetFlightInfo`: metadata about available datasets
- `DoGet`: stream Arrow RecordBatches from server to client
- `DoPut`: stream Arrow RecordBatches from client to server
- `DoExchange`: bidirectional streaming

**Applicability to duckspace (local desktop):**

| Factor | Assessment |
|--------|------------|
| Network transport | Flight uses gRPC/HTTP2. Unnecessary overhead for in-process Electron IPC |
| Serialization | Flight uses Arrow IPC format internally -- same as direct MessagePort transfer |
| Service discovery | Designed for distributed systems, not needed for single-process communication |
| Authentication | Includes auth tokens, TLS -- entirely unnecessary for local desktop |
| Language support | Strong in Python/C++/Java, weaker in JS/Node.js |
| npm package | `apache-arrow` does not include Flight; requires separate native dependency |

### 6.2 Overhead Analysis

```
Direct MessagePort + Arrow IPC:
  Sender: tableToIPC() -> ArrayBuffer
  Transfer: postMessage with transfer list (zero-copy)
  Receiver: tableFromIPC() -> Table
  Overhead: ~0 (just flatbuffer metadata parsing)

Arrow Flight:
  Sender: Flight server (gRPC server process) -> serialize to Arrow IPC -> HTTP2 framing
  Transfer: TCP loopback (localhost:port) -> HTTP2 -> gRPC deserialization
  Receiver: Flight client -> Arrow IPC deserialization -> Table
  Overhead: gRPC server lifecycle, TCP connection, HTTP2 framing, protobuf metadata
```

**Flight adds 3-5 layers of overhead** over direct `MessagePort` transfer with no functional benefit for the duckspace use case.

### 6.3 Verdict on Arrow Flight

**Do not use Arrow Flight for duckspace.** It is designed for network-distributed Arrow data services (data lakes, query engines serving multiple clients). For a single-user desktop app with in-process databases, direct `MessagePort` + Arrow IPC stream format is strictly superior in every dimension: latency, complexity, bundle size, and memory efficiency.

Arrow Flight could be relevant in the future if duckspace adds a "server mode" that exposes datasets over the network, but this is explicitly out of scope (single-user, local-first).

---

## 7. Memory Layout Considerations

### 7.1 Arrow Columnar Format Alignment

Arrow's in-memory columnar format specifies:
- **64-byte alignment** for all buffer starts (enables SIMD operations)
- **8-byte (64-bit) padding** at buffer ends
- **Validity bitmaps** for nullable columns (1 bit per value, padded to 64-byte boundary)
- **Offset buffers** for variable-length types (int32 or int64 offsets)

**Relevance to Electron IPC:**
- `ArrayBuffer` in V8 is always 8-byte aligned (platform guarantee)
- Arrow IPC format includes alignment padding within the serialized stream
- When deserializing with `tableFromIPC()`, Arrow JS respects the alignment within the buffer
- **No special handling needed** -- Arrow IPC format preserves alignment across transfer

### 7.2 Buffer Sharing Across V8 Isolates

Electron's Main Process and Renderer Process run in separate V8 isolates:
- Each has its own heap, GC, and `ArrayBuffer` allocator
- `ArrayBuffer` transfer moves ownership between isolates (the backing memory is OS-level, not V8-heap-specific)
- `SharedArrayBuffer` maps the same OS-level memory pages into both isolates

**Worker threads (Node.js `worker_threads`):**
- Each worker has its own V8 isolate
- `SharedArrayBuffer` is the recommended mechanism for sharing large data with workers
- Transfer semantics (move) also work but prevent the main thread from retaining a copy

**Memory lifecycle considerations:**
- Transferred `ArrayBuffer`: GC'd by the receiving isolate when no references remain
- `SharedArrayBuffer`: GC'd only when all isolates release their references (ref-counted by V8)
- For Arrow data: once a `RecordBatch` is consumed by visualization and no longer needed, the underlying `ArrayBuffer` should be released (let references go out of scope)

**Cache management pattern:**
```
Main Process (DuckDB)
  -> Arrow IPC ArrayBuffer (short-lived: produced, transferred, released)
    -> Renderer Process (receives ArrayBuffer)
      -> Arrow Table (wraps ArrayBuffer, held while rendering)
        -> Visualization (reads columns from Table)
          -> When view changes: release Table, request new query
```

This pattern ensures memory is held only where it's actively used, consistent with stream-and-scan.

---

## 8. Trade-Off Analysis

### 8.1 True Zero-Copy (SharedArrayBuffer) vs Transfer Semantics (ArrayBuffer Transfer)

| Dimension | SharedArrayBuffer | ArrayBuffer Transfer |
|-----------|-------------------|---------------------|
| Data copy | None (true shared memory) | None (move semantics) |
| Sender retains data | Yes (shared) | No (neutered) |
| Concurrency | Requires careful synchronization | No concurrency (exclusive ownership) |
| Security requirements | COOP/COEP headers, cross-origin isolation | None |
| Setup complexity | Moderate (isolation setup, lifecycle management) | Low (just add to transfer list) |
| Use case | Multiple readers, caching, re-reads | One-shot data delivery |
| Arrow fit | Good (Arrow buffers are immutable after creation) | Excellent (natural for query-response pattern) |

**Recommendation:** Use **ArrayBuffer transfer** as the default for query-response patterns (Renderer requests data, Main responds with Arrow batches). Reserve **SharedArrayBuffer** for specific scenarios:
- Worker thread sharing (already well-supported in Node.js)
- Cached lookup tables that multiple Renderer components read simultaneously
- High-frequency small updates where the overhead of repeated transfers is measurable

### 8.2 IPC Overhead: Small vs Large Datasets

| Dataset Size | Rows | Approx IPC Payload | Transfer Time (est.) | Serialization Overhead | Recommendation |
|-------------|------|---------------------|---------------------|----------------------|----------------|
| Tiny | <100 | <10 KB | <0.1ms | Dominates | JSON acceptable, Arrow optional |
| Small | 100-10K | 10 KB - 1 MB | 0.1-1ms | Noticeable | Arrow worthwhile for typed data |
| Medium | 10K-100K | 1-50 MB | 1-10ms | Minimal vs payload | Arrow strongly recommended |
| Large | 100K-1M | 50-500 MB | 10-100ms | Negligible | Arrow required, must stream |
| Very large | 1M+ | 500MB+ | >100ms | Negligible | Arrow required, must stream + aggregate |

**Note:** The constitution mandates Arrow everywhere ("no JSON serialization in hot paths"). For consistency and to avoid maintaining two code paths, use Arrow even for small payloads. The serialization overhead for small payloads (~100us for `tableToIPC`) is acceptable.

### 8.3 Arrow IPC Complexity vs Simpler Serialization

| Approach | Pros | Cons |
|----------|------|------|
| Arrow IPC | Zero-copy transfer, typed columns, standard format, visualization libraries consume directly | Learning curve, binary format harder to debug |
| JSON | Human-readable, easy to debug, built-in `JSON.parse` | Copies data, loses type info, slow for large payloads, violates constitution |
| Protocol Buffers | Compact binary, schema-enforced | Requires schema compilation, not columnar, copies data |
| MessagePack | Compact binary, schema-less | Not columnar, copies data, no visualization library support |
| Flatbuffers | Zero-copy reads, schema-enforced | Not columnar, Arrow already uses flatbuffers for metadata |

**Verdict:** Arrow IPC is the only option that satisfies the constitution's Arrow-first mandate, provides zero-copy semantics, and is directly consumable by the visualization stack (Perspective.js uses Arrow natively).

---

## Recommendation

### Primary Architecture

**Use Arrow IPC stream format with ArrayBuffer transfer over Electron MessagePort channels.**

This is the recommended architecture for all data flow between Main and Renderer processes:

```
[Renderer Process]                    [Main Process]
  |                                     |
  |-- QueryDescriptor (JSON) --------->|
  |                                     |-- DuckDB.query()
  |                                     |-- Arrow IPC stream (batches)
  |<--- Arrow IPC batch (transfer) ----|
  |<--- Arrow IPC batch (transfer) ----|
  |<--- Arrow IPC batch (transfer) ----|
  |<--- End-of-stream signal ----------|
  |                                     |
  |-- tableFromIPC() -> Table           |
  |-- Perspective/Plot consumes         |
```

**Implementation specifics:**

1. **Channel setup:** Create a dedicated `MessageChannelMain` per logical data channel (one for queries, one for catalog metadata, etc.). Avoid multiplexing all data over a single channel.

2. **Query protocol:** Renderer sends structured query descriptors (not raw SQL) for UI-driven queries. Parameterized SQL allowed for AI/advanced queries. Main process translates descriptors to DuckDB SQL.

3. **Response format:** Always Arrow IPC stream format. Even metadata responses (table list, column info) use Arrow for consistency.

4. **Streaming:** All queries stream results as Arrow RecordBatch chunks via the MessagePort. Use window-based flow control (window size 4) for backpressure.

5. **Batch sizing:** Default 65,536 rows per batch. Adjust based on schema width to target 1-4MB per batch.

6. **Error handling:** Errors sent as JSON control messages on the same port. Arrow is for data; JSON is for control plane (query requests, ACKs, errors, metadata).

7. **Cancellation:** Renderer sends a `cancel` message; Main process aborts the DuckDB query and sends an `end` signal.

### Secondary Mechanisms

- **SharedArrayBuffer for Worker Threads:** When Main process offloads computation to worker threads (e.g., embedding generation, data transformation), use `SharedArrayBuffer` to share Arrow data between main thread and workers without copying.

- **Memory-mapped Arrow files:** For very large static datasets, consider writing Arrow IPC File format to disk and memory-mapping it in both Main and Renderer. This provides true zero-copy with persistence. Evaluate only if datasets exceed available RAM.

### Design Principles Alignment

| Principle | How This Architecture Satisfies It |
|-----------|-----------------------------------|
| Arrow-First (9) | All data transfer uses Arrow IPC format |
| Embedded-Only (10) | DuckDB runs in Main process, no external servers |
| Stream and Scan (11) | Batch streaming with backpressure, never bulk-load |
| Process Isolation (12) | Main owns DB, Renderer owns viz, clear boundary at MessagePort |
| macOS-First (13) | All technologies work on macOS Electron |
| Single-User (14) | No auth, no multi-user concerns |

---

## Alternatives Considered

### Alternative 1: Arrow Flight RPC

**Description:** Use Arrow Flight (gRPC-based) for Main-Renderer communication.

**Why rejected:**
- Adds gRPC server/client overhead unnecessary for in-process IPC
- Requires native gRPC dependency (bundle size, build complexity)
- Arrow Flight JS support is immature
- TCP loopback adds latency vs direct MessagePort
- No functional benefit over direct transfer for single-user desktop app

**When to reconsider:** If duckspace adds a "server mode" exposing data over the network.

### Alternative 2: JSON Serialization with Structured Clone

**Description:** Serialize query results as JSON, use default `postMessage` (structured clone).

**Why rejected:**
- Violates constitution principle 9 (Arrow-first, no JSON in hot paths)
- Full data copy on every transfer (structured clone copies the object graph)
- Loses type information (dates become strings, BigInt unsupported)
- Significantly slower for datasets >10K rows
- Visualization libraries (Perspective.js) would need to re-parse into columnar format

**When to reconsider:** Never for data payloads. JSON remains appropriate for control messages (queries, ACKs, errors).

### Alternative 3: SharedArrayBuffer Only (No Transfer)

**Description:** Use SharedArrayBuffer exclusively for all data sharing.

**Why rejected:**
- Requires COOP/COEP isolation setup (complexity)
- Lifecycle management more complex (must track when all readers are done)
- Need memory management protocol (ring buffer or arena allocator) to avoid fragmentation
- Arrow's immutable buffers help, but still need coordination on buffer reuse
- Overkill for query-response pattern where transfer semantics are simpler and sufficient

**When to reconsider:** If profiling shows transfer overhead is significant for the workload pattern, or for specific high-frequency update scenarios.

### Alternative 4: Protocol Buffers / FlatBuffers Custom Schema

**Description:** Define custom protobuf/flatbuffer schemas for data transfer instead of Arrow IPC.

**Why rejected:**
- Arrow IPC is already a FlatBuffers-based format optimized for columnar data
- Custom schemas mean custom serialization code, duplicating what Arrow provides
- Visualization libraries expect Arrow format; custom format adds a conversion step
- DuckDB outputs Arrow natively; custom format adds a conversion step on the producer side too
- No advantage over Arrow IPC for columnar analytics data

**When to reconsider:** Never for tabular data. Possibly for non-tabular payloads (images, documents) but those are outside the data plane.

### Alternative 5: Electron IPC (ipcMain/ipcRenderer) Instead of MessagePort

**Description:** Use Electron's built-in `ipcMain.handle()` / `ipcRenderer.invoke()` instead of MessagePort channels.

**Why rejected:**
- `ipcMain`/`ipcRenderer` uses structured clone (copies data)
- Does not support `Transferable` objects (no zero-copy ArrayBuffer transfer)
- All messages go through the Electron main event loop (potential bottleneck)
- MessagePort allows direct renderer-to-renderer communication without main process relay

**When to reconsider:** For simple request/response control messages where data size is small. Use `ipcMain.handle()` for queries that return metadata (table names, column schemas) rather than data payloads.

---

## Open Questions for Downstream Tasks

1. **DuckDB Node.js binding maturity:** Which specific binding (`duckdb`, `@duckdb/node-bindings`, `duckdb-async`) provides the best Arrow IPC streaming API? Needs hands-on evaluation.

2. **Perspective.js Arrow consumption:** Does Perspective.js accept Arrow IPC buffers directly, or does it require conversion to Arrow JS `Table` first? If it has a custom Arrow reader, the `apache-arrow` npm package may only be needed for non-Perspective visualizations.

3. **Electron MessagePort + ReadableStream transfer:** Is `ReadableStream` transfer via `postMessage` stable in the Electron version duckspace will target? If so, it provides the cleanest streaming API with built-in backpressure.

4. **SharedArrayBuffer COOP/COEP impact:** Does enabling cross-origin isolation in Electron's BrowserWindow cause any issues with the visualization libraries or other Renderer dependencies?

---

## References

- [Apache Arrow JS Documentation](https://arrow.apache.org/docs/js/)
- [Arrow IPC Streaming Format Specification](https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format)
- [Electron MessageChannelMain](https://www.electronjs.org/docs/latest/api/message-channel-main)
- [MDN Transferable Objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- [SharedArrayBuffer and Cross-Origin Isolation](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)
- [DuckDB Arrow Interface](https://duckdb.org/docs/api/c/api#arrow-interface)
- [Perspective.js Architecture](https://perspective.finos.org/docs/js/)
