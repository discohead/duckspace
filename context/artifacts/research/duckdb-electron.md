# DuckDB Integration in Electron: Technology Evaluation

**Research Finding** | duckspace Project
**Date:** 2026-02-04
**Scope:** Evaluate DuckDB technology options for embedding in an Electron desktop analytics application

---

## Executive Summary

DuckDB is an embedded columnar OLAP database designed for analytical workloads. It offers two deployment paths for Electron: a native Node.js addon (`duckdb-node`) and a WebAssembly build (`duckdb-wasm`). This document evaluates both options against duckspace's constraints: embedded-only databases, Apache Arrow-first data flow, stream-and-scan processing, Worker Thread isolation, and macOS-first targeting.

The recommendation is to use **duckdb-node (native addon) hosted in a dedicated Worker Thread**, with Apache Arrow as the query result format.

---

## 1. duckdb-node (Native Addon) vs duckdb-wasm

### 1.1 duckdb-node (Native Addon)

**Package:** `duckdb-node` (npm: `duckdb`)

**How it works:** A C++ native addon compiled via node-gyp (or prebuild binaries) that links directly against the DuckDB C++ library. It runs DuckDB in-process as a shared library loaded into the Node.js runtime.

**Advantages:**
- Full DuckDB performance: vectorized execution engine operates at native speed with no interpretation overhead.
- Complete feature parity with DuckDB CLI: all extensions, all SQL features, all data types.
- Native memory management: DuckDB's buffer manager operates directly on system memory and can memory-map files.
- Direct Apache Arrow export: DuckDB's C API supports Arrow array streaming natively (via `duckdb_query_arrow`), enabling zero-copy result transfer.
- Smaller in-memory overhead than WASM (no WASM runtime, no linear memory abstraction).
- Full support for DuckDB extensions (httpfs, parquet, json, spatial) loaded as shared libraries.

**Disadvantages:**
- Requires native compilation or prebuilt binaries for the target platform (macOS arm64/x64).
- Electron's native module story requires `electron-rebuild` or `@electron/rebuild` to recompile against Electron's Node.js ABI.
- Binary size: the DuckDB shared library is approximately 30-50 MB (varies by platform and enabled extensions).
- Native crashes (segfaults) in DuckDB can bring down the entire Electron process unless isolated in a Worker Thread or child process.

**Electron-specific considerations:**
- Electron ships its own version of Node.js; native addons must be compiled against Electron's headers. This is well-supported by `electron-rebuild`.
- Since duckspace targets macOS-first, only one platform binary is needed initially (arm64 for Apple Silicon, x64 for Intel Macs). Universal binaries are possible.
- Prebuilt binaries for `duckdb` npm package are published via `node-pre-gyp` for common Node.js versions; Electron ABI alignment must be verified.

### 1.2 duckdb-wasm

**Package:** `@duckdb/duckdb-wasm`

**How it works:** DuckDB compiled to WebAssembly, running inside a JavaScript runtime. Can execute in the browser, Web Workers, or Node.js (via WASM runtime).

**Advantages:**
- No native compilation required: the WASM binary is platform-independent.
- Can run in Renderer Process (browser context) or Main Process (Node.js context).
- Isolation: WASM has a sandboxed linear memory model; crashes are contained.
- Simplified distribution: no `electron-rebuild` step.

**Disadvantages:**
- **Performance:** 2-5x slower than native for compute-bound analytical queries. The WASM overhead comes from: (a) 32-bit pointer model limiting addressable memory to 4GB per WASM instance, (b) no SIMD utilization on all platforms (WASM SIMD is available but not as mature as native AVX2/NEON), (c) no memory-mapped file I/O.
- **Memory ceiling:** WASM linear memory is limited. While it can grow, the 32-bit address space caps at 4GB. DuckDB native can use the full system memory.
- **Extension support:** Not all DuckDB extensions are available in WASM builds. The httpfs extension works (using fetch API), but spatial and some others may be missing or limited.
- **Arrow integration:** duckdb-wasm returns Arrow-compatible results via its JavaScript API, but this is Arrow IPC serialized in WASM memory, then copied to JS. It is not true zero-copy because data must cross the WASM/JS boundary.
- **Bundle size:** The WASM binary is approximately 20-30 MB (compressed ~8-12 MB). Combined with the JS wrapper, total payload is comparable to native.
- **File system access:** duckdb-wasm uses a virtual file system. Accessing local files requires registering them explicitly or using the OPFS (Origin Private File System) in browser contexts. In Node.js context, this is less of an issue but adds complexity.

### 1.3 Performance Comparison

| Dimension | Native Addon | WASM |
|-----------|-------------|------|
| Query execution | 1x (baseline) | 2-5x slower |
| Memory limit | System RAM | ~4GB (WASM32) |
| Startup time | ~100-200ms | ~300-500ms (WASM compile) |
| Arrow result format | Native Arrow arrays (zero-copy possible) | Arrow IPC (requires copy across boundary) |
| File I/O | Direct OS file access, mmap | Virtual FS, explicit registration |
| SIMD | Full AVX2/NEON | WASM SIMD (subset) |
| Extension support | Full | Partial |
| Bundle size | ~30-50MB (platform-specific) | ~20-30MB (universal) |

### 1.4 Verdict: Native vs WASM

For duckspace, the **native addon is the clear choice**:
- The "stream and scan" principle demands maximum I/O throughput; native file access and mmap are essential.
- The "Arrow-first data flow" principle benefits from DuckDB's native Arrow output, which avoids the WASM boundary copy.
- The 4GB WASM memory limit conflicts with handling large analytical datasets.
- macOS-first constraint eliminates the portability advantage of WASM.
- Worker Thread isolation (see Section 2) addresses native crash concerns.

---

## 2. Worker Thread Hosting

### 2.1 Architecture

The constitution mandates: "Main Process owns database engines. Worker Threads isolate heavy computation." DuckDB should be loaded in a **dedicated Worker Thread** spawned from the Main Process.

```
Main Process
  |
  +-- DuckDB Worker Thread
  |     - Loads duckdb native addon
  |     - Owns DuckDB database instance
  |     - Executes queries
  |     - Returns Arrow buffers via MessagePort
  |
  +-- Renderer Process (UI)
        - Sends queries via IPC -> Main -> Worker
        - Receives Arrow buffers for visualization
```

### 2.2 Worker Thread Benefits

- **Isolation:** Long-running analytical queries do not block the Main Process event loop. The Main Process remains responsive for IPC, window management, and coordination.
- **Crash containment:** If DuckDB's native code encounters a fatal error, the Worker Thread terminates without crashing the Main Process. The Main Process can detect the crash and respawn the worker.
- **Memory accounting:** Worker Threads have their own V8 isolate, making it easier to monitor and limit memory usage separately from the Main Process.
- **Parallelism:** DuckDB internally uses threads for query execution. Hosting it in a Worker Thread ensures DuckDB's thread pool does not compete with Main Process work.

### 2.3 Worker Thread Considerations

- **Native addon loading:** Node.js Worker Threads can load native addons. The `duckdb` native addon can be `require()`d inside a Worker Thread. There are no fundamental restrictions, but the addon must be thread-safe (DuckDB is designed for this).
- **Data transfer:** Results must be transferred from Worker Thread to Main Process (and then to Renderer). Apache Arrow buffers are `ArrayBuffer` instances, which can be transferred (not copied) via `worker.postMessage(data, [transferList])`. This enables zero-copy transfer from Worker to Main.
- **MessagePort chaining:** For Renderer -> Main -> Worker communication, Electron's `MessagePort` API can be used. A `MessagePort` can be transferred from Main to Worker, allowing Renderer to communicate directly with the Worker Thread (bypassing Main Process for data transfer). This is optimal for Arrow buffer transfer.
- **Startup cost:** Spawning a Worker Thread and loading the DuckDB addon takes ~200-500ms. This should be done once at app startup, not per-query.

### 2.4 Worker Thread vs Child Process

| Aspect | Worker Thread | Child Process |
|--------|--------------|---------------|
| Memory sharing | SharedArrayBuffer possible | Requires IPC serialization |
| Arrow transfer | Zero-copy via transferList | Must serialize/deserialize |
| Startup time | ~200-500ms | ~500-1000ms |
| Crash isolation | Thread terminates, process survives | Full process isolation |
| DuckDB file locking | Same process, shared file handles | Separate process, potential lock conflicts |
| Complexity | Moderate | Higher |

Worker Thread is the better fit: it enables zero-copy Arrow buffer transfer and keeps DuckDB's database file within a single OS process (avoiding file lock complications).

---

## 3. Apache Arrow Result Format

### 3.1 DuckDB's Native Arrow Support

DuckDB has first-class Apache Arrow support:

- **Arrow output:** DuckDB can produce query results directly as Arrow record batches. The C API function `duckdb_query_arrow` returns an Arrow array stream. The Node.js addon exposes this via the `arrowIPCAll()` and `arrowIPCStream()` methods (in newer versions).
- **Arrow input:** DuckDB can scan Arrow tables as virtual tables, enabling zero-copy ingestion of Arrow data from other sources.
- **Arrow IPC format:** Results can be serialized in Arrow IPC format (Feather v2), which is the standard wire format for inter-process Arrow data transfer.

### 3.2 Arrow Flow in duckspace

The intended Arrow data flow for queries:

1. **Renderer** sends SQL query string via IPC to Main Process.
2. **Main Process** forwards query to DuckDB Worker Thread (via MessagePort).
3. **DuckDB Worker** executes query, produces Arrow record batches.
4. **DuckDB Worker** serializes Arrow batches to IPC format (Arrow IPC buffers are `ArrayBuffer`).
5. **Worker** transfers `ArrayBuffer` to Main Process via `postMessage` with `transferList` (zero-copy).
6. **Main Process** forwards `ArrayBuffer` to Renderer via Electron IPC (can use `SharedArrayBuffer` or `transferable` for zero-copy).
7. **Renderer** deserializes Arrow IPC buffer using `apache-arrow` JS library, feeds to visualization layer (Perspective.js accepts Arrow directly).

### 3.3 Arrow Libraries

- **apache-arrow (JS):** The official Apache Arrow JavaScript library. Used in Renderer to deserialize Arrow IPC buffers. Also usable in Main/Worker for Arrow manipulation. ~500KB minified.
- **DuckDB built-in:** DuckDB's Arrow output does not require the `apache-arrow` JS library on the producer side; the native addon generates Arrow-format buffers directly.

### 3.4 Zero-Copy Considerations

True zero-copy end-to-end is challenging in Electron due to process boundaries:

| Boundary | Zero-Copy Method | Notes |
|----------|-----------------|-------|
| DuckDB -> Worker JS | Native Arrow output | Minimal copy; Arrow buffers allocated in native heap, wrapped as ArrayBuffer |
| Worker -> Main | `postMessage` with `transferList` | Zero-copy transfer; ownership moves |
| Main -> Renderer | Electron `MessagePort` with transferable | Zero-copy transfer possible via `port.postMessage(buf, [buf])` |

The key insight: Arrow IPC buffers as `ArrayBuffer` instances are transferable across all Electron boundaries without copying.

---

## 4. Streaming vs Materialized Results

### 4.1 Materialized Results

- DuckDB executes the full query and materializes all result rows into Arrow record batches.
- Suitable for queries returning bounded result sets (aggregations, filtered subsets).
- Memory usage proportional to result size.

### 4.2 Streaming Results

- DuckDB supports streaming query execution via its streaming result API.
- Results are produced as a sequence of Arrow record batches (chunks), each typically 1024-2048 rows.
- The `duckdb-node` addon supports `each()` and `all()` callbacks; Arrow streaming requires using the Arrow stream API.
- Streaming is critical for the "stream and scan" principle: large result sets should be consumed chunk-by-chunk.

### 4.3 Streaming in Worker Thread Context

The Worker Thread can stream Arrow chunks to the Main Process:

1. Execute query with streaming result.
2. For each Arrow chunk, transfer the chunk buffer via `postMessage`.
3. Main Process forwards each chunk to Renderer.
4. Renderer consumes chunks incrementally (e.g., progressive rendering in Perspective.js).

This approach keeps memory usage bounded regardless of result set size.

### 4.4 Recommendation

Use **streaming by default** for all queries. Materialize only when the consumer needs the full result at once (e.g., small lookup queries, metadata queries). The streaming approach aligns with the "stream and scan" constraint and enables progressive visualization.

---

## 5. DuckDB Extensions

### 5.1 Relevant Extensions

| Extension | Purpose | Relevance to duckspace |
|-----------|---------|------------------------|
| **parquet** | Read/write Parquet files | **Critical.** Primary columnar file format for local data. DuckDB reads Parquet with predicate pushdown and column pruning. |
| **json** | Read JSON/JSONL files | **High.** Supports JSON data ingestion. DuckDB auto-detects JSON schema. |
| **httpfs** | Read files from HTTP/S3 | **High.** Enables remote data access (S3 buckets, HTTP-hosted Parquet/CSV). Supports S3 authentication. |
| **icu** | Unicode collation | **Medium.** Correct text sorting for international data. Bundled by default. |
| **fts** | Full-text search | **Medium.** Basic full-text search. LanceDB may serve this role instead. |
| **spatial** | Geospatial functions | **Low-Medium.** Only if duckspace handles geospatial data. Adds ST_ functions, GeoJSON support. |
| **excel** | Read Excel files | **Medium.** Common data format for desktop analytics users. |

### 5.2 Extension Loading in Electron

- Extensions are shared libraries (`.duckdb_extension` files) loaded at runtime.
- In Electron, extensions must be bundled with the app and their paths configured.
- DuckDB supports setting the extension directory: `SET extension_directory='/path/to/extensions'`.
- Extensions can be autoloaded or explicitly loaded via `LOAD parquet`.
- For Electron distribution, pre-download required extensions and bundle them in the app's resources directory.

### 5.3 Extension Bundle Size Impact

| Extension | Approximate Size |
|-----------|-----------------|
| parquet | ~5 MB |
| json | ~3 MB |
| httpfs | ~5 MB |
| icu | ~10 MB |
| spatial | ~15 MB |
| fts | ~2 MB |
| excel | ~3 MB |

Total for recommended set (parquet + json + httpfs + icu): ~23 MB additional to the ~30-50 MB core DuckDB library.

---

## 6. Memory Management

### 6.1 DuckDB Buffer Pool

DuckDB uses an internal buffer pool manager for memory management:

- **Configuration:** `SET memory_limit='4GB'` controls the maximum memory DuckDB will use for its buffer pool.
- **Spill to disk:** When the buffer pool is exhausted, DuckDB can spill intermediate results to a temporary directory. Configure via `SET temp_directory='/path/to/temp'`.
- **Default behavior:** If no memory limit is set, DuckDB will use up to 80% of available system memory.

### 6.2 Memory Configuration for Electron

For a desktop application, memory must be shared with the OS, Electron, Renderer, and other processes:

**Recommended defaults:**
- Set `memory_limit` to 50% of system RAM (e.g., 8GB on a 16GB Mac).
- Allow user configuration via app settings.
- Set `temp_directory` to app's data directory for spill-to-disk.
- Monitor memory usage via `PRAGMA database_size` and DuckDB's memory tracking.

### 6.3 Memory and Arrow Buffers

Arrow buffers produced by DuckDB are allocated in native memory outside V8's heap. This means:
- Arrow result buffers do not count against Node.js `--max-old-space-size`.
- They do count against system memory and should be freed promptly after transfer.
- When using `transferList` in `postMessage`, the buffer is moved (not copied), so memory is not doubled during transfer.

---

## 7. Concurrent Query Handling

### 7.1 DuckDB's Concurrency Model

DuckDB supports multiple concurrent readers and a single writer:

- **Multiple readers:** Many SELECT queries can execute concurrently. DuckDB uses MVCC (Multi-Version Concurrency Control) for read isolation.
- **Single writer:** Only one transaction can write at a time. Write transactions block other writers but not readers.
- **In-process threading:** DuckDB uses an internal thread pool (configurable via `SET threads=N`) for intra-query parallelism.

### 7.2 Implications for duckspace

- **Read-heavy workload:** duckspace is primarily an analytics tool. Most queries are reads (SELECT). Multiple visualization panels can query concurrently without contention.
- **Write operations:** Data ingestion (COPY INTO, INSERT) and metadata updates are writes. These should be serialized and managed by the Worker Thread's query queue.
- **Query cancellation:** DuckDB supports query interruption via `duckdb_interrupt`. The Worker Thread should expose a cancel mechanism for long-running queries.

### 7.3 Thread Pool Configuration

- DuckDB's internal thread count should be set to leave headroom for Electron:
  - On an 8-core Mac: `SET threads=6` (leave 2 cores for Electron Main/Renderer).
  - On a 4-core Mac: `SET threads=2`.
- The Worker Thread itself is one OS thread; DuckDB spawns additional threads internally.

---

## 8. Lance Extension for DuckDB

### 8.1 Overview

The Lance columnar format (used by LanceDB) has a DuckDB extension that allows DuckDB to query Lance datasets directly:

- **Extension name:** `lance` (community/experimental).
- **Capability:** Register Lance datasets as DuckDB virtual tables, enabling SQL queries over Lance data.
- **Use case for duckspace:** Unified SQL interface across DuckDB's native tables and LanceDB's vector storage. A single query could join structured data (DuckDB) with vector search results (LanceDB).

### 8.2 Current Status

- The Lance DuckDB extension is in early/experimental stage.
- It may not support all Lance features (e.g., vector index queries may need to go through LanceDB's native API).
- The extension would need to be compiled for the target Electron Node.js ABI.

### 8.3 Evaluation

- **Potential value:** High. A unified SQL query layer across DuckDB and LanceDB tables simplifies the query API significantly.
- **Risk:** The extension is not mature. duckspace should design the architecture to work without it (separate DuckDB and LanceDB query paths) but leave room to adopt it when stable.
- **Alternative approach:** Use DuckDB's Arrow scan capability to import LanceDB query results as Arrow tables, then join/filter in DuckDB. This is more robust and doesn't depend on the Lance extension.

---

## 9. Bundle Size Analysis

### 9.1 Native Addon Bundle

| Component | Size (approx) |
|-----------|---------------|
| DuckDB core library (libduckdb) | 30-50 MB |
| Node.js addon wrapper | ~1 MB |
| Extensions (parquet + json + httpfs + icu) | ~23 MB |
| **Total** | **~54-74 MB** |

### 9.2 WASM Bundle

| Component | Size (approx) |
|-----------|---------------|
| duckdb-wasm binary | 20-30 MB |
| JS wrapper + Web Worker glue | ~2 MB |
| Extensions (fewer available) | ~10-15 MB |
| **Total** | **~32-47 MB** |

### 9.3 Verdict

The native addon is larger but not prohibitively so. For a desktop application (not a web page), 54-74 MB for a full analytical database engine is acceptable. Electron itself is ~150-200 MB; DuckDB adds roughly 30-40% to the base Electron size.

---

## Alternatives Considered

### Alternative 1: SQLite with Analytics Extensions

- **What:** Use SQLite as the analytical engine instead of DuckDB.
- **Why rejected:** SQLite is row-oriented and not optimized for analytical (OLAP) queries. DuckDB's columnar engine provides 10-100x better performance for aggregations, scans, and joins on large datasets. SQLite lacks native Arrow output and columnar storage.
- **Note:** RxDB already uses SQLite for operational/reactive data. Using SQLite for analytics would conflate two different workload types.

### Alternative 2: duckdb-wasm in Renderer Process

- **What:** Run duckdb-wasm directly in the Renderer Process (browser context), bypassing the Main Process entirely.
- **Why rejected:** Violates the "Main Process owns databases" constraint. Also limited by WASM's 4GB memory ceiling and the lack of direct file system access in Renderer. Performance penalty of 2-5x is unacceptable for large analytical queries.

### Alternative 3: DuckDB as a Separate Child Process

- **What:** Run DuckDB in a separate Node.js child process (via `child_process.fork()`) rather than a Worker Thread.
- **Why rejected:** Child processes require IPC serialization for data transfer, making zero-copy Arrow buffer transfer impossible. File locking is also more complex across process boundaries. Worker Threads provide sufficient isolation with better data transfer characteristics.

### Alternative 4: ClickHouse Local (chdb)

- **What:** Use ClickHouse's embedded mode (chdb) instead of DuckDB.
- **Why rejected:** chdb is less mature than DuckDB for embedded use cases. DuckDB has better Node.js bindings, better Arrow integration, and a more active embedded/analytical community. ClickHouse is primarily designed as a server; embedded mode is secondary.

### Alternative 5: Polars (via Node.js bindings)

- **What:** Use Polars DataFrame library instead of DuckDB for analytical processing.
- **Why rejected:** Polars is a DataFrame library, not a database. It lacks persistent storage, SQL interface, and MVCC concurrency. DuckDB provides a full SQL interface, persistent catalog, and can work with Polars via Arrow interop. They could complement each other, but Polars cannot replace DuckDB as the primary analytical engine.

---

## Recommendation

### Primary Recommendation

**Use `duckdb-node` (native addon) hosted in a dedicated Worker Thread, with Apache Arrow IPC as the query result format.**

### Rationale

1. **Performance:** Native DuckDB provides the best possible analytical query performance, essential for the "stream and scan" principle with large datasets.

2. **Arrow integration:** DuckDB's native Arrow output aligns perfectly with the "Arrow-first data flow" constraint. Arrow buffers can be transferred zero-copy from Worker Thread through Main Process to Renderer.

3. **Worker Thread isolation:** Hosting DuckDB in a Worker Thread satisfies the "Worker Threads isolate heavy computation" constraint while keeping data transfer efficient via transferable ArrayBuffers.

4. **Extension ecosystem:** The full extension set (parquet, json, httpfs) is available, enabling direct reading of common data formats and remote sources.

5. **Streaming results:** DuckDB's streaming Arrow result API enables bounded-memory query execution, satisfying the "never load full datasets into JS memory" principle.

6. **macOS-first simplicity:** Targeting only macOS eliminates the primary disadvantage of native addons (cross-platform compilation). Only arm64 and x64 binaries are needed.

### Configuration Recommendations

| Setting | Recommended Value | Rationale |
|---------|-------------------|-----------|
| `memory_limit` | 50% of system RAM | Leave room for Electron, OS, visualizations |
| `threads` | System cores - 2 | Leave cores for Main/Renderer |
| `temp_directory` | App data directory | Spill-to-disk for large queries |
| Extensions | parquet, json, httpfs, icu | Core data format and remote access support |

### Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Native addon compilation issues | Use `@electron/rebuild`; publish prebuilt binaries for target Electron versions |
| DuckDB crashes in Worker Thread | Worker crash detection + automatic respawn in Main Process |
| Memory overuse | Configure `memory_limit`; monitor via DuckDB pragmas; user-configurable |
| Large bundle size | Accept as cost of native performance; compress with ASAR |
| DuckDB version upgrades | Pin version in package.json; test upgrades in CI |

### Future Considerations

- **Lance DuckDB extension:** Monitor maturity. When stable, it could provide unified SQL over DuckDB + LanceDB data. Design the query layer to accommodate this.
- **DuckDB WASM fallback:** If cross-platform becomes a priority, duckdb-wasm could serve as a fallback for platforms where native compilation is difficult. The Arrow-based query interface would remain the same.
- **Shared memory:** Investigate `SharedArrayBuffer` for Main <-> Renderer Arrow transfer to reduce copy overhead further.

---

*Research conducted for duckspace system architecture design. This document evaluates technology options only; it does not design the database integration layer.*
