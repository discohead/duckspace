# ADR-005: Electron Process Architecture

**Status:** Accepted
**Date:** 2026-02-04
**Deciders:** duckspace Architecture Team
**Supersedes:** N/A

---

## Context

duckspace is a macOS-first desktop analytics application built on Electron. It embeds three database engines (DuckDB for SQL analytics, LanceDB for vector search, RxDB/SQLite for UI state), uses Apache Arrow as its universal data transfer format, and relies on GPU-accelerated visualization libraries (Perspective.js, Observable Plot, ECharts).

The central architectural question is: **how should these components be distributed across Electron's available process types?**

Electron provides four process types, each with distinct capabilities and constraints:

- **Main Process**: A Node.js runtime with full OS access, native module loading, window management, and IPC dispatch. It is single-threaded by default; synchronous work on its event loop blocks all window management and IPC. If the Main Process hangs, every window freezes.

- **Renderer Process**: A Chromium content process with the full web platform (DOM, Canvas, WebGL, WebGPU). With Electron v28+ defaults, context isolation and sandbox are enabled -- the Renderer has no access to Node.js APIs. Communication with the Main Process occurs exclusively through `contextBridge`-exposed APIs and `ipcRenderer.invoke`.

- **Worker Threads** (`worker_threads`): V8 isolates running on separate threads within the Main Process's OS process. They can load native Node.js modules, share memory via `SharedArrayBuffer`, and transfer `ArrayBuffer` instances zero-copy. A native module crash in a Worker Thread crashes the entire application.

- **UtilityProcess** (Electron-specific): Separate OS processes managed by Electron. They provide crash isolation and independent memory spaces but cannot share memory with the Main Process and cannot communicate directly with Renderer Processes (all communication must proxy through Main).

The project's Constitution (principles #9, #10, #11, #12) imposes hard constraints:

- **Arrow-First Data Flow** (#9): All inter-component data transfer must use Apache Arrow. JSON serialization in hot paths is a design violation.
- **Embedded-Only Databases** (#10): No external database servers. DuckDB, LanceDB, and RxDB all run in-process within Electron.
- **Stream and Scan** (#11): No component may load full datasets into JavaScript memory. All data access must use streaming, scanning, or predicate pushdown.
- **Process Isolation** (#12): Main Process owns database engines. Renderer Process owns visualization. Worker Threads isolate heavy computation.

The architecture must satisfy these constraints while minimizing IPC overhead for Arrow buffer transfer, keeping the Main Process responsive, and maintaining crash resilience appropriate for a single-user desktop application.

---

## Decision

### Process Topology

duckspace adopts a **Single Renderer + Main Process + 3 Dedicated Worker Threads** architecture.

| Component | Process | Responsibility |
|-----------|---------|----------------|
| UI / Visualization | Renderer Process | Perspective.js, Observable Plot, ECharts rendering; DOM management; WebGPU-accelerated display |
| Client-side data prep | Renderer Web Workers | Arrow buffer preparation for visualization; layout computation; offloading from renderer main thread |
| Application lifecycle | Main Process | Window management, IPC dispatch, global configuration, startup/shutdown orchestration |
| RxDB (catalog/state) | Main Process | Catalog metadata, user preferences, query history; change streams to Renderer via IPC events |
| DuckDB | Worker Thread #1 | SQL query execution, data scanning, aggregation; Arrow result buffers transferred to Renderer |
| LanceDB | Worker Thread #2 | Vector search, embedding storage, index management |
| Computation pipeline | Worker Thread #3 | Arrow transformations, data export pipeline, ingestion processing |

### Main Process Responsibilities

The Main Process serves as the **control plane** and **lifecycle manager**:

1. **Application lifecycle**: Creates and manages the BrowserWindow, handles app activation/deactivation, manages startup sequence.
2. **IPC hub**: Hosts `ipcMain.handle()` endpoints for control messages (configuration changes, catalog operations, error reporting). Does NOT relay data-plane traffic.
3. **RxDB hosting**: Runs RxDB with the SQLite adapter for small-volume state management (catalog metadata, user preferences, query history). RxDB change streams are dispatched to the Renderer via `webContents.send()`.
4. **Worker Thread lifecycle**: Spawns, monitors, and restarts the three dedicated Worker Threads. Manages MessagePort channel setup between Workers and Renderer.
5. **MessagePort orchestration**: Creates `MessageChannelMain` pairs, sends one port to the Renderer (via `webContents.postMessage`) and the other to the corresponding Worker Thread, establishing direct data channels.
6. **Native menu and system integration**: Global shortcuts, system tray, macOS-native menus, file open/save dialogs.

### Renderer Process Responsibilities

The Renderer Process is a **pure visualization and interaction layer**:

1. **Visualization rendering**: Hosts Perspective.js, Observable Plot, and ECharts. Leverages WebGPU (Electron v28+) for GPU-accelerated rendering.
2. **UI state management**: Manages component state, layout, user interaction, and navigation.
3. **Data reception**: Receives Arrow `ArrayBuffer` instances via MessagePort channels from Worker Threads. Buffers are transferred (zero-copy ownership move), not copied.
4. **Client-side data prep**: Uses Web Workers within the Renderer to prepare Arrow record batches for visualization libraries, compute chart layouts, and handle data format conversion for display.
5. **Control API via contextBridge**: Exposes a typed API surface through `contextBridge.exposeInMainWorld()` for sending control messages to the Main Process (query requests, configuration changes, catalog operations).

The Renderer never hosts database engines, loads native modules, or performs heavy computation on its main thread.

### Worker Thread Allocation

Each database engine and compute workload runs on a dedicated Worker Thread:

**Worker Thread #1 -- DuckDB Worker**
- Loads the `duckdb` N-API native addon
- Executes SQL queries against local data files
- Returns results as Arrow IPC buffers transferred via MessagePort to the Renderer
- Configured with explicit memory limit (`SET memory_limit='2GB'`)
- Handles query cancellation via `AbortSignal`

**Worker Thread #2 -- LanceDB Worker**
- Loads the `vectordb` N-API native addon
- Manages vector indices (memory-mapped from disk)
- Executes vector similarity search and embedding operations
- Returns results as Arrow buffers
- Uses memory-mapped I/O for indices to minimize heap usage

**Worker Thread #3 -- Computation Worker**
- Loads `apache-arrow` Node.js bindings
- Performs Arrow-to-Arrow transformations (filtering, projection, aggregation)
- Handles data export pipeline (Arrow to Parquet, CSV, etc.)
- Processes data ingestion (CSV/JSON to Arrow conversion)
- Acts as a general-purpose compute executor for operations that do not belong to DuckDB or LanceDB

**Rationale for dedicated workers:**
- Different workload patterns (DuckDB: bursty queries; LanceDB: sustained index operations; Compute: batch transformations) are isolated from each other.
- Independent lifecycle: one worker can be restarted without affecting the others.
- Per-engine memory limits prevent one engine from starving another.
- Clean error boundaries: a failure in one engine does not cascade.

### Preload Script and contextBridge API Surface

The preload script exposes a typed API via `contextBridge.exposeInMainWorld('duckspace', api)`:

**Control plane API (Renderer to Main via IPC):**
- `query.execute(sql: string, params?: unknown[]): Promise<void>` -- Initiates a query; results arrive via MessagePort data channel
- `query.cancel(queryId: string): Promise<void>` -- Cancels an in-flight query
- `catalog.list(): Promise<CatalogEntry[]>` -- Lists available data sources
- `catalog.register(source: DataSourceConfig): Promise<string>` -- Registers a new data source
- `config.get(key: string): Promise<unknown>` -- Reads application configuration
- `config.set(key: string, value: unknown): Promise<void>` -- Updates configuration
- `vector.search(query: VectorQuery): Promise<void>` -- Initiates vector search; results via MessagePort
- `export.start(config: ExportConfig): Promise<void>` -- Starts data export pipeline
- `lifecycle.ready(): Promise<void>` -- Signals renderer is initialized
- `lifecycle.onStateChange(callback): void` -- Subscribes to RxDB change stream events

**Design principles for the API surface:**
- All data-returning operations return `void` at the IPC level; actual data arrives via MessagePort (separating control from data plane).
- contextBridge serialization uses structured clone; overhead is identical to standard IPC and is negligible for control messages.
- The API is intentionally narrow to minimize the attack surface between isolated and non-isolated worlds.

### MessagePort Channels

Three direct MessagePort channels are established at application startup:

| Channel | Endpoints | Purpose | Data Format |
|---------|-----------|---------|-------------|
| `duckdb-data` | Renderer <-> DuckDB Worker | Query results, streaming record batches | Arrow IPC `ArrayBuffer` (Transferable) |
| `lance-data` | Renderer <-> LanceDB Worker | Vector search results, embedding results | Arrow IPC `ArrayBuffer` (Transferable) |
| `compute-data` | Renderer <-> Computation Worker | Transformation results, export progress | Arrow IPC `ArrayBuffer` (Transferable) |

**Channel setup sequence:**
1. Main Process spawns Worker Thread and waits for its `ready` message.
2. Main Process creates a `MessageChannelMain` pair: `{port1, port2}`.
3. Main Process sends `port1` to the Worker Thread via `worker.postMessage`.
4. Main Process sends `port2` to the Renderer via `webContents.postMessage`.
5. Both endpoints store their port and listen for messages.
6. The channel is now live; data flows directly between Worker and Renderer.

**Key property:** The Main Process is not in the data path after channel setup. Arrow buffers flow directly between Worker Threads and the Renderer, avoiding Main Process as a bottleneck. The Main Process remains responsible only for control-plane operations (lifecycle, configuration, error handling, catalog updates).

---

## Alternatives

### Alternative 1: UtilityProcess for Database Hosting

**Description:** Run DuckDB and LanceDB in separate `UtilityProcess` instances instead of Worker Threads.

**Advantages:**
- Full crash isolation: a DuckDB native module segfault would not crash the application. The UtilityProcess can be detected as crashed and restarted.
- Independent memory address spaces: memory leaks in one process do not affect others.
- Easier debugging with separate process stdio access.
- Independent V8 heap limits with no shared native memory concerns.

**Disadvantages:**
- No `SharedArrayBuffer` across the process boundary. Arrow zero-copy sharing is impossible; only Transferable ownership moves are available.
- Cannot establish a direct MessagePort between UtilityProcess and Renderer. All data must proxy through the Main Process, adding latency and load to the Main Process event loop.
- Higher spawn overhead (~50-200 ms per process vs ~5-30 ms per Worker Thread).
- Higher total memory footprint (each process has its own V8 heap and native memory).
- The "Arrow-First Data Flow" principle (Constitution #9) demands minimal transfer overhead; the proxy requirement violates this for high-throughput data paths.

**Why rejected:** The performance cost of proxying all Arrow data through the Main Process is unacceptable for an application built around zero-copy Arrow IPC. Worker Threads enable direct Renderer communication via MessagePort and near-instant Transferable transfer within the same address space.

**Escape hatch:** If DuckDB native module stability becomes a concern (repeated segfaults in production), specific operations can be incrementally migrated to UtilityProcess without redesigning the overall architecture.

### Alternative 2: Multiple Renderer Windows (Multi-Window Architecture)

**Description:** Each major view (query editor, dashboard, catalog browser) runs in its own BrowserWindow with its own Renderer Process.

**Advantages:**
- Independent V8 heaps per view; large visualizations do not affect other views.
- Crash isolation between views; a renderer crash in one view does not lose state in another.
- Native macOS multi-window experience with independent window management.

**Disadvantages:**
- Complex state synchronization: shared query results, catalog state, and user preferences must be synchronized across renderers via IPC or a pub/sub layer.
- Higher total memory usage: each renderer loads its own copies of Perspective.js, Observable Plot, and other libraries.
- MessagePort channels between renderers require Main Process coordination for setup and error handling.
- Single-user desktop application does not benefit from multi-window complexity in the initial design.

**Why rejected:** The synchronization complexity outweighs the benefits for duckspace's initial single-user, single-focus design. Constitution principle #14 (Single-User, Local-First) means there is no concurrent-use scenario driving multi-window needs.

**Escape hatch:** A "detach chart to new window" feature can be added later by creating a new BrowserWindow for a specific visualization. This is an additive change that does not require redesigning the core architecture.

### Alternative 3: Database in Renderer via WASM

**Description:** Compile DuckDB to WebAssembly and run it directly in the Renderer Process, eliminating IPC for database queries entirely.

**Advantages:**
- Zero IPC overhead for queries: DuckDB runs in the same process as the visualization code.
- Simpler architecture: no Worker Threads, no MessagePort setup, no cross-process coordination.
- DuckDB-WASM is a mature, well-tested distribution.

**Disadvantages:**
- WASM execution is slower than native N-API addon (typically 2-5x for compute-intensive operations).
- The Renderer's main thread would be blocked during query execution unless DuckDB-WASM is run in a Web Worker (adding complexity back).
- WASM memory is limited and harder to manage than native memory in the Main Process.
- Violates Constitution principle #12 (Process Isolation): database engines must not run in the Renderer Process.
- Cannot use native file system APIs from the sandboxed Renderer; file access would still require IPC to Main Process.
- LanceDB does not have a WASM distribution; would still need Worker Threads for LanceDB, creating an inconsistent architecture.

**Why rejected:** Violates process isolation principle, limits performance compared to native addon, and creates an inconsistent architecture since LanceDB has no WASM option.

### Alternative 4: Shared Workers for Cross-Window Communication

**Description:** Use Shared Workers as a communication hub if multi-window support is ever needed.

**Advantages:**
- Standard web platform API for sharing state between windows.
- Built-in connection management.

**Disadvantages:**
- Shared Workers run in the Renderer's web context; cannot load native modules.
- Cannot host databases or perform native computation.
- Only useful if multi-window architecture is adopted (which was rejected in Alternative 2).
- Redundant with Electron's IPC and MessagePort mechanisms.

**Why rejected:** Not applicable to the chosen single-Renderer architecture. If multi-window support is added later, Electron's IPC and MessagePort provide superior capabilities compared to Shared Workers.

### Alternative 5: All Computation on Main Process (No Worker Threads)

**Description:** Run DuckDB, LanceDB, and all computation directly on the Main Process event loop using async APIs.

**Advantages:**
- Simplest possible architecture; no Worker Thread lifecycle management.
- No IPC overhead for database access; direct function calls.

**Disadvantages:**
- Even async database operations have synchronous phases that block the Main Process event loop.
- Main Process blocking causes all windows to freeze (unresponsive UI).
- No path to concurrent query execution (cannot run DuckDB and LanceDB queries simultaneously).
- Violates Constitution principle #12 (Process Isolation).

**Why rejected:** Blocking the Main Process event loop is unacceptable for a responsive desktop application. Constitution principle #12 explicitly requires Worker Thread isolation for heavy computation.

---

## Consequences

### Positive Consequences

1. **Zero-copy Arrow data plane**: MessagePort channels between Worker Threads and Renderer enable Transferable `ArrayBuffer` transfer. Arrow IPC buffers move without serialization or copying, achieving the Arrow-First Data Flow principle (Constitution #9).

2. **Main Process remains responsive**: Database queries and heavy computation execute on Worker Threads. The Main Process handles only lightweight control operations (lifecycle, configuration, small RxDB state queries), keeping window management and IPC dispatch responsive at all times.

3. **Crash isolation for Renderer**: If the Renderer Process crashes (e.g., due to a visualization library bug), database state is preserved in the Worker Threads and Main Process. The Renderer can be recreated and reconnected to existing data channels.

4. **Independent database lifecycle**: Each database engine runs on its own Worker Thread with independent lifecycle. DuckDB can be restarted (e.g., after a configuration change) without affecting LanceDB or the Computation Worker. This enables targeted recovery and configuration changes.

5. **Memory isolation between V8 heaps**: Each Worker Thread has its own V8 isolate with configurable heap limits. Database engines manage their own native memory outside V8. This prevents one component's memory usage from starving another's V8 heap.

6. **Incremental path to UtilityProcess**: If crash isolation for native modules becomes necessary, individual Worker Threads can be migrated to UtilityProcess instances. The MessagePort-based communication pattern remains the same; only the channel setup changes.

### Negative Consequences

1. **IPC overhead for all database queries**: Every database query crosses a process/thread boundary. While Arrow Transferable transfer is near-zero-cost for data, the request/response coordination adds ~0.1-1.0 ms of latency per query round-trip. For interactive use cases (sub-second queries), this overhead is acceptable. For extremely high-frequency micro-queries, batching may be required.

2. **No SharedArrayBuffer across Renderer-Worker boundary**: Despite Worker Threads supporting `SharedArrayBuffer` with the Main Process, the Renderer-Worker MessagePort channel crosses a Chromium process boundary. Arrow buffers must be transferred (ownership moved), not shared. This means the Worker cannot retain a reference to a buffer after sending it to the Renderer. If both sides need the same data, it must be materialized twice or explicitly requested back.

3. **Thread pool sizing**: Three dedicated Worker Threads plus the Main Process's thread pool (default 4 libuv threads) means the application uses at minimum 7-8 OS threads. On machines with fewer cores, this may cause contention. Thread pool sizing should be tuned based on available CPU cores, with a minimum of 4 cores recommended.

4. **Worker Thread crash risk**: A native module segfault in any Worker Thread crashes the entire application (Main Process, Renderer, and all Worker Threads share the same OS process). DuckDB and LanceDB native addons are mature, but this risk is inherent to the Worker Thread model. Mitigation: implement watchdog monitoring, graceful degradation, and state persistence so the application can restart cleanly.

5. **Startup sequence complexity**: The application must initialize components in a specific order:
   - Main Process initializes, creates BrowserWindow
   - Worker Threads are spawned and report `ready`
   - MessageChannelMain pairs are created
   - Ports are distributed to Renderer and Workers
   - Renderer signals `lifecycle.ready()` after receiving ports
   - Application is interactive only after all channels are established
   This sequence adds ~100-300 ms to startup time and requires careful error handling (what if a Worker fails to start?).

6. **Debugging complexity**: Worker Threads are harder to debug than Main Process code. Standard Node.js debugging tools work, but stepping across MessagePort channels and correlating events between threads requires structured logging and request tracing (e.g., correlation IDs on all messages).

7. **Memory monitoring**: Native memory allocated by DuckDB and LanceDB in Worker Threads shares the same OS process address space as the Main Process. A memory leak in a Worker Thread's native code eventually affects the entire application. Active monitoring via `process.memoryUsage()` (specifically `rss` and `external` fields) is required, along with explicit memory limits on each database engine.

---

## References

- [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron UtilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron MessageChannelMain API](https://www.electronjs.org/docs/latest/api/message-channel-main)
- [Electron contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge)
- [Node.js worker_threads](https://nodejs.org/api/worker_threads.html)
- [DuckDB Node.js API](https://duckdb.org/docs/api/nodejs/overview)
- [Apache Arrow JavaScript](https://arrow.apache.org/docs/js/)
- duckspace Constitution (`.orchestrator/decomposition/constitution.yaml`)
- Electron Process Model Research (`.orchestrator/artifacts/research/electron-process-model.md`)
