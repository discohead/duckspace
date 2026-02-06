# ADR-002: Apache Arrow Data Plane

**Status:** Accepted
**Date:** 2026-02-04
**Deciders:** datspace Architecture Team
**Domain:** System Design - datspace

---

## Context

datspace is a single-user, local-first Electron desktop application for analytical data exploration. Its architecture involves three process boundaries: a Main Process (hosting DuckDB in a Worker Thread, LanceDB, RxDB), a Renderer Process (hosting Perspective.js, Observable Plot, ECharts for visualization), and auxiliary Worker Threads for heavy computation.

These process boundaries create a critical design question: **how should analytical data be transferred between the database engines and the visualization layer?**

The requirements driving this decision:

1. **Performance**: Analytical queries can return hundreds of thousands to millions of rows. The transfer mechanism must handle large columnar datasets without becoming a bottleneck. Serialization and deserialization overhead must be minimized relative to query execution time.

2. **Zero-copy aspirations**: The ideal data path avoids copying bytes entirely. In practice, true zero-copy across all boundaries is not achievable in Electron (the DuckDB native-to-V8 boundary requires one copy), but every subsequent transfer -- from Worker Thread to Main Process to Renderer -- should be zero-copy.

3. **Interoperability**: DuckDB produces Apache Arrow natively via its C API (`duckdb_query_arrow`). Perspective.js consumes Arrow natively. These two anchoring technologies define a natural Arrow-based data plane. The transfer format must be directly consumable by both the producer (DuckDB) and the consumer (visualization libraries) without intermediate conversion.

4. **Constitutional constraints**: The project constitution mandates Arrow-first data flow (Principle 9: "All inter-component data transfer MUST use Apache Arrow. JSON serialization in hot paths is a design violation."), stream-and-scan processing (Principle 11), and process isolation (Principle 12). The data plane design must satisfy all three.

5. **Type fidelity**: Analytical data includes typed columns (integers, floats, decimals, timestamps, strings, booleans, nested types). The transfer format must preserve type information end-to-end without lossy conversion (e.g., dates becoming strings, BigInt becoming Number).

---

## Decision

### Primary Mechanism: Arrow IPC Stream Format with ArrayBuffer Transfer over MessagePort

All data transfer between Main Process and Renderer Process uses **Apache Arrow IPC stream format**, with `ArrayBuffer` instances **transferred** (not copied) via Electron `MessagePort` channels.

The specific design decisions are:

### 1. Transfer Mechanism: MessagePort with ArrayBuffer Transfer

Electron's `MessageChannelMain` creates direct `MessagePort` pairs between processes. Arrow IPC buffers are `ArrayBuffer` instances passed in the `postMessage` transfer list, which moves ownership to the receiver with zero memory copy. The sender's buffer is neutered (becomes zero-length) after transfer.

```
Renderer -> Main: QueryDescriptor (JSON control message)
Main -> DuckDB Worker: Query forwarded via MessagePort
DuckDB Worker -> Main -> Renderer: Arrow IPC ArrayBuffer (transferred, zero-copy)
```

This is preferred over `SharedArrayBuffer` as the default because:
- The query-response pattern is naturally one-shot (produce, transfer, consume, discard).
- Move semantics (exclusive ownership) eliminate concurrency concerns entirely.
- No security setup required (no COOP/COEP cross-origin isolation headers).
- Simpler lifecycle management -- the GC in the receiving isolate handles cleanup.

### 2. IPC Format: Arrow IPC Stream Format

Arrow defines two IPC serialization formats: Stream and File. We use **Stream format** for all inter-process communication:

- Stream format supports incremental emission and consumption (schema message, then N RecordBatch messages, then end-of-stream).
- Lower overhead than File format (no footer, no magic bytes).
- Directly aligned with chunked/streaming transfer over MessagePort.
- File format is reserved for persistent storage (e.g., writing Arrow files to disk for memory-mapped access), not for IPC.

Serialization uses the `apache-arrow` npm package APIs:
- Producer: `tableToIPC(table, 'stream')` or `RecordBatchStreamWriter`
- Consumer: `tableFromIPC(buffer)` or `RecordBatchStreamReader`

### 3. Predicate Pushdown Protocol

Since the Main Process owns the database engines (Principle 12), the Renderer must request data by sending query descriptors, not by pulling raw data and filtering locally.

Two query descriptor formats are supported:

- **Structured query descriptors** for UI-driven queries: A JSON object specifying `source`, `columns`, `filters`, `aggregations`, `groupBy`, and `options`. This format prevents SQL injection from plugin code and enables the Main Process to optimize query plans.

- **Parameterized SQL** for advanced and AI-generated queries: A SQL string with `?` parameter placeholders and a separate params array. This provides full SQL flexibility while preventing injection through parameter binding.

The key principle: **filter at the source, not after transfer**. DuckDB performs filtering and aggregation using its columnar scan engine (with SIMD acceleration) before serializing results to Arrow. The Renderer receives only the data it will render. Client-side filtering is permitted only on small, already-transferred result sets for interactive cross-filtering within a dashboard.

### 4. Streaming Chunked Transfer for Large Results

All queries stream results as a sequence of Arrow RecordBatch chunks over the MessagePort:

- Default batch size: **65,536 rows** (Arrow's conventional 2^16 default).
- For wide tables (many columns), batch size is reduced to target **1-4 MB per batch**.
- For narrow tables, batch size can increase to 131,072 or 262,144 rows.
- Batch size is configurable per query based on schema width.

Flow control uses **window-based backpressure** with a window size of 4:
- The producer (Main/Worker) sends up to 4 batches before requiring ACKs.
- The consumer (Renderer) sends an ACK message for each consumed batch.
- If the consumer falls behind, the producer pauses until ACKs arrive.

Protocol messages:
- `{ type: 'arrow-batch', index: N, data: ArrayBuffer }` -- transferred with `[data]` in the transfer list.
- `{ type: 'ack', index: N }` -- consumer confirms batch N is consumed.
- `{ type: 'arrow-end', totalBatches: N }` -- producer signals stream completion.
- `{ type: 'error', message: string, code: string }` -- error on the same channel.
- `{ type: 'cancel' }` -- consumer requests query cancellation.

### 5. Small Payload Threshold

Arrow IPC has a fixed serialization cost (FlatBuffer metadata, schema encoding, buffer alignment padding) of approximately 100-200 microseconds per batch. For payloads under ~100 rows or ~10 KB, this overhead can exceed the cost of JSON serialization.

However, to maintain a single code path and comply with the constitution's Arrow-first mandate (Principle 9), **Arrow is used for all data payloads regardless of size**. The serialization overhead for small payloads is acceptable (~100 microseconds) and eliminates the complexity of maintaining two serialization paths and the decision logic to choose between them.

JSON is reserved exclusively for the **control plane**: query descriptors, ACK messages, error messages, and lifecycle signals. Data never flows as JSON.

### 6. Channel Architecture

Dedicated `MessageChannelMain` instances are created per logical communication channel:
- **Query data channel**: Arrow IPC batch transfer for query results.
- **Catalog metadata channel**: Schema information, table listings (still Arrow-formatted for consistency).
- **Control channel**: Query submission, cancellation, status updates (JSON).

This separation prevents large data transfers from blocking control messages and allows independent flow control per channel.

---

## Alternatives

### Alternative 1: JSON Serialization

**Description:** Serialize query results as JSON objects, transfer via Electron's default `postMessage` (structured clone).

**Assessment:**
- Directly violates constitution Principle 9 (Arrow-first, no JSON in hot paths).
- Structured clone copies the entire object graph on every transfer -- no zero-copy path.
- Loses type information: `Date` objects become strings, `BigInt` is unsupported, decimal precision is lost.
- Performance degrades rapidly beyond 10K rows (JSON.stringify/parse becomes the bottleneck).
- Visualization libraries (Perspective.js) would need to re-parse JSON into columnar format, duplicating the data in memory.

**Verdict:** Rejected. Not viable for analytical data transfer. JSON remains appropriate only for control plane messages.

### Alternative 2: Protocol Buffers

**Description:** Define custom Protocol Buffer schemas for query results, serialize with protobuf.

**Assessment:**
- Compact binary format with schema enforcement and evolution support.
- Row-oriented encoding: each row is a separate message. Not columnar, so column-oriented operations (aggregation, filtering) require full deserialization.
- Requires separate schema compilation step (`.proto` files, `protoc` compiler).
- No direct consumption by visualization libraries -- an additional conversion step is needed.
- DuckDB does not output Protocol Buffers natively -- an additional conversion step on the producer side.
- Does not support zero-copy transfer semantics the way Arrow IPC does (protobuf decoding always copies).

**Verdict:** Rejected. Adds conversion overhead on both producer and consumer sides with no advantage over Arrow IPC for columnar analytics data.

### Alternative 3: SharedArrayBuffer as Primary Mechanism

**Description:** Use `SharedArrayBuffer` exclusively for all Arrow data sharing between Main and Renderer, enabling true zero-copy shared memory.

**Assessment:**
- True shared memory: multiple contexts read the same physical memory pages, no transfer needed.
- Arrow buffers are immutable after creation, which fits the shared-memory read pattern well (no locking needed for readers).
- Requires enabling cross-origin isolation (COOP/COEP headers) on Electron's `BrowserWindow`, which can break third-party resources loaded without CORS.
- Requires explicit memory lifecycle management: a protocol to determine when all readers are done so the buffer can be reused or freed. Without this, memory leaks are likely.
- Requires a memory management protocol (ring buffer or arena allocator) to avoid fragmentation in long-running sessions.
- Overkill for the dominant query-response pattern where data is produced, transferred once, consumed, and discarded.

**Verdict:** Rejected as the primary mechanism. `SharedArrayBuffer` is reserved for specific secondary scenarios:
- Worker Thread data sharing within the Main Process (already well-supported in Node.js `worker_threads`).
- Cached lookup tables read by multiple Renderer components simultaneously.
- High-frequency small updates where repeated ArrayBuffer transfers show measurable overhead.

### Alternative 4: Arrow Flight RPC

**Description:** Use Arrow Flight, a gRPC-based RPC framework designed for streaming Arrow data between services.

**Assessment:**
- Arrow Flight uses gRPC over HTTP/2 -- designed for network-distributed systems, not in-process Electron IPC.
- Adds 3-5 layers of unnecessary overhead: gRPC server lifecycle, TCP loopback connection, HTTP/2 framing, protobuf metadata encoding.
- Requires a native gRPC dependency, increasing bundle size and build complexity.
- Arrow Flight JavaScript/Node.js support is immature compared to Python/C++/Java.
- The `apache-arrow` npm package does not include Flight; it requires a separate native dependency.
- No functional benefit over direct MessagePort transfer for a single-user desktop application.
- Latency: TCP loopback + HTTP/2 framing adds measurable latency vs. direct in-process MessagePort.

**Verdict:** Rejected. Arrow Flight solves the wrong problem (network distribution) for datspace (local in-process IPC). Reconsider only if datspace adds a "server mode" exposing datasets over the network, which is explicitly out of scope per Principle 14 (single-user, local-first).

### Alternative 5: Electron ipcMain/ipcRenderer

**Description:** Use Electron's built-in `ipcMain.handle()` / `ipcRenderer.invoke()` for data transfer instead of MessagePort.

**Assessment:**
- Uses structured clone internally, which copies data (no zero-copy ArrayBuffer transfer).
- All messages route through Electron's main event loop, creating a potential bottleneck for high-throughput data streaming.
- Does not support `Transferable` objects in the transfer list.
- Cannot establish direct Renderer-to-Renderer channels without Main Process relay.
- Simpler API surface, but fundamentally incompatible with zero-copy requirements.

**Verdict:** Rejected for data plane. Acceptable for simple control-plane request/response patterns (e.g., fetching a list of table names as metadata) where data volume is negligible.

---

## Consequences

### Positive Consequences

1. **Unified data format**: All components -- DuckDB (producer), MessagePort (transport), `apache-arrow` JS (deserialization), Perspective.js (consumer) -- speak Arrow natively. No format conversion anywhere in the hot path.

2. **Zero-copy transfer within Electron**: After the single unavoidable copy at the DuckDB native-to-V8 boundary, all subsequent transfers between Worker Thread, Main Process, and Renderer are zero-copy via ArrayBuffer transfer semantics.

3. **Type fidelity**: Arrow's rich type system (int8-64, float16-64, decimal128, timestamp with timezone, utf8, binary, list, struct, map, union) preserves column types end-to-end from DuckDB to visualization without lossy conversion.

4. **Bounded memory consumption**: Streaming chunked transfer with backpressure ensures that neither the producer nor the consumer holds the entire result set in memory at once. This satisfies the stream-and-scan principle (Principle 11).

5. **Clean process boundary**: The MessagePort with Arrow IPC creates a well-defined serialization boundary between Main Process (data) and Renderer Process (visualization), satisfying Principle 12.

### Negative Consequences

1. **All components must understand Arrow format**: Every component in the data path must be able to produce or consume Arrow IPC. This constrains technology choices -- future visualization libraries or data processing components must support Arrow or will require a conversion adapter.

2. **Additional dependency on `apache-arrow` npm package**: The Renderer Process requires the `apache-arrow` npm package (~500 KB minified) for deserializing Arrow IPC buffers into `Table`/`RecordBatch` objects. This adds to bundle size and introduces a dependency that must be kept in sync with the Arrow version produced by DuckDB.

3. **Binary format debugging difficulty**: Arrow IPC is a binary format. Unlike JSON, it cannot be inspected in browser DevTools or logged to the console in human-readable form. Debugging data transfer issues requires purpose-built tooling (e.g., Arrow JS `Table.toString()`, custom DevTools panels, or hex inspection of IPC buffers).

4. **Serialization boundary design**: The architecture must clearly define where Arrow begins and ends:
   - Arrow begins at DuckDB query output (native Arrow buffers).
   - Arrow persists through Worker Thread -> Main Process -> Renderer transfer.
   - Arrow ends at the visualization library consumption point (Perspective.js reads Arrow columns).
   - Control messages (query descriptors, ACKs, errors) remain JSON -- the control plane is explicitly outside the Arrow boundary.
   - Any component that needs to transform data (e.g., data enrichment, computed columns) must operate on Arrow RecordBatches, not on deserialized JS objects.

5. **Memory ownership transfer semantics**: ArrayBuffer transfer neutering means the sender loses access to the data after sending. Code must be written with move semantics in mind:
   - The DuckDB Worker produces an Arrow buffer, transfers it, and cannot read it afterward.
   - If the Main Process needs to inspect or log query results, it must do so before transferring to Renderer.
   - Caching strategies must account for the fact that transferred buffers are gone from the sender. If caching is needed, either the cache lives in the Renderer (where data is consumed) or `SharedArrayBuffer` is used for shared caching (secondary mechanism).

6. **Backpressure protocol complexity**: Window-based flow control adds protocol complexity to the MessagePort communication. Both sides must correctly implement ACK handling, and bugs in the backpressure protocol can cause either memory exhaustion (if ACKs are lost and the producer keeps sending) or stalls (if ACKs are never sent and the producer blocks indefinitely). This protocol must be thoroughly tested.

---

## Implementation Notes

### Data Flow Diagram

```
[Renderer Process]                         [Main Process]
  |                                          |
  |                                          +-- [DuckDB Worker Thread]
  |                                          |     |
  |-- QueryDescriptor (JSON) ------------->  |     |
  |                                          | --> | DuckDB.query()
  |                                          |     | Arrow RecordBatch stream
  |                                          |     |
  |                                          | <-- | ArrayBuffer transfer (zero-copy)
  |<-- Arrow IPC batch (transfer) --------- |     |
  |<-- Arrow IPC batch (transfer) --------- |     |
  |-- ACK (JSON) -------------------------> |     |
  |<-- Arrow IPC batch (transfer) --------- |     |
  |<-- Arrow IPC batch (transfer) --------- |     |
  |-- ACK (JSON) -------------------------> |     |
  |<-- end-of-stream (JSON) --------------- |     |
  |                                          |
  |-- tableFromIPC() -> Arrow Table          |
  |-- Perspective.js / Plot consumes         |
```

### Constitution Alignment

| Principle | How This Decision Satisfies It |
|-----------|-------------------------------|
| 9. Arrow-First Data Flow | All data transfer uses Arrow IPC stream format. JSON is control-plane only. |
| 10. Embedded-Only Databases | DuckDB runs in-process in a Worker Thread. No external servers. No Arrow Flight server. |
| 11. Stream and Scan | Chunked batch streaming with backpressure. Never bulk-load full results. |
| 12. Process Isolation | Main Process owns DuckDB (via Worker Thread). Renderer owns visualization. MessagePort is the boundary. |
| 13. macOS-First | All technologies (Electron MessagePort, Arrow JS, DuckDB native addon) work on macOS. |
| 14. Single-User, Local-First | No authentication, no multi-user concerns, no network RPC (Arrow Flight rejected). |

### Open Questions for Downstream Tasks

1. Which specific DuckDB Node.js binding (`duckdb`, `@duckdb/node-bindings`, `duckdb-async`) provides the best Arrow IPC streaming API? Requires hands-on evaluation during implementation.
2. Does Perspective.js accept Arrow IPC buffers directly via `table()`, or does it require conversion to Arrow JS `Table` first?
3. Is `ReadableStream` transfer via `postMessage` stable in the target Electron version? If so, it could replace window-based backpressure with built-in stream backpressure.
4. Does enabling COOP/COEP for `SharedArrayBuffer` (secondary mechanism) cause compatibility issues with visualization libraries?

---

## References

- [Apache Arrow JS Documentation](https://arrow.apache.org/docs/js/)
- [Arrow IPC Streaming Format Specification](https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format)
- [Electron MessageChannelMain API](https://www.electronjs.org/docs/latest/api/message-channel-main)
- [MDN Transferable Objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- [DuckDB Arrow Interface](https://duckdb.org/docs/api/c/api#arrow-interface)
- [Research: Arrow IPC in Electron](../research/arrow-ipc-electron.md)
- [Research: DuckDB in Electron](../research/duckdb-electron.md)
