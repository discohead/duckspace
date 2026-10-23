# Electron Process Model for duckspace

**Type:** Research Finding
**Date:** 2026-02-04
**Scope:** Evaluate Electron's process architecture for a macOS-first desktop analytics application with embedded databases, Arrow-based IPC, and GPU-accelerated visualization.

---

## Executive Summary

Electron provides a multi-process architecture rooted in Chromium's process model. For duckspace -- a single-user desktop analytics app hosting DuckDB, LanceDB, and RxDB with Apache Arrow data transfer -- the critical decision is how to distribute database engines, computation, and visualization across Electron's process boundaries. This document evaluates the available process types, communication mechanisms, and memory management strategies, then recommends a specific process topology.

---

## 1. Electron Process Types

### 1.1 Main Process

The Main Process is a Node.js runtime with full access to the operating system. It manages application lifecycle, creates BrowserWindows, and has unrestricted access to native Node.js modules and N-API addons.

**Capabilities:**
- Load native modules (`.node` addons) compiled against Electron's Node.js ABI
- Access the filesystem, spawn child processes, open network sockets
- Create and manage BrowserWindow instances
- Register global shortcuts, system tray, native menus
- Host IPC endpoints via `ipcMain.handle()` for request/response patterns

**Limitations:**
- Single-threaded by default (Node.js event loop); long-running synchronous work blocks window management and IPC dispatch
- If the Main Process hangs, all windows freeze (cannot create new windows, respond to IPC, or handle OS events)
- V8 heap is shared with all Main Process JavaScript; default limit is ~1.5 GB on 64-bit systems (configurable via `--max-old-space-size`)
- No direct access to DOM or Web APIs

**Relevance to duckspace:**
The Main Process is the natural host for database engine initialization and lifecycle management. However, running DuckDB queries synchronously on the Main Process event loop would block IPC dispatch and window management. This motivates offloading actual query execution to Worker Threads or UtilityProcess instances.

### 1.2 Renderer Process

Each BrowserWindow runs in an isolated Renderer Process -- a Chromium content process with a full web platform stack (DOM, CSS, Canvas, WebGL, WebGPU, Web Workers).

**Capabilities:**
- Full web platform: DOM, Canvas 2D, WebGL 2.0, WebGPU (Electron v28+)
- Web Workers for off-main-thread computation within the renderer
- SharedArrayBuffer support (with proper headers or Electron configuration)
- OffscreenCanvas for worker-thread rendering

**Constraints (with context isolation enabled, which is the Electron v28+ default):**
- No direct access to Node.js APIs (`require`, `fs`, `child_process`, etc.)
- Cannot load native modules
- Communication with Main Process only through `contextBridge`-exposed APIs and `ipcRenderer.invoke()` / `ipcRenderer.send()`
- Each renderer has its own V8 heap; memory is not shared with Main Process
- Chromium sandbox restricts filesystem and OS access

**Relevance to duckspace:**
The Renderer Process is where Perspective.js, Observable Plot, and ECharts render visualizations. It should never host database engines or perform heavy data transformation. Data arrives via IPC as Arrow buffers; the renderer's job is to visualize, not compute.

### 1.3 Worker Threads (Node.js `worker_threads`)

Worker Threads run in the Main Process's Node.js runtime but on separate V8 isolates with their own event loops. They share the same native process address space as the Main Process.

**Capabilities:**
- Load and execute native Node.js modules (same ABI as Main Process)
- Share memory with Main Process via `SharedArrayBuffer`
- Transfer `ArrayBuffer` instances zero-copy via `Transferable` / structured clone with transfer list
- Each Worker Thread has its own V8 isolate and garbage collector
- Can use `MessagePort` for direct communication channels (including with renderer processes via Electron's `MessageChannelMain`)

**Limitations:**
- Spawning a Worker Thread has overhead (~5-30 ms, plus V8 isolate initialization)
- Each Worker Thread adds its own V8 heap (configurable, but adds to total process memory)
- Worker Threads share the same OS process as Main; a native module segfault in a Worker Thread crashes the entire application
- No built-in process isolation or crash recovery; a stuck Worker Thread must be terminated and restarted manually
- Limited to CPU-bound work; no DOM or web platform APIs

**Relevance to duckspace:**
Worker Threads are the primary mechanism for hosting DuckDB and LanceDB instances. They can load the native addons, execute queries off the Main Process event loop, and transfer Arrow buffers back to the Main Process (or directly to the renderer via MessagePort) without serialization overhead.

### 1.4 UtilityProcess (Electron-specific)

Introduced in Electron v22, `UtilityProcess` spawns a separate OS process (a Node.js child process managed by Electron) that can load native modules.

**Capabilities:**
- Runs in a separate OS process with its own memory space
- Can load native Node.js modules
- Communicates with Main Process via `MessagePort` (structured clone + transferables)
- Process crashes do not bring down the Main Process
- Can be restarted independently

**Limitations:**
- Higher spawn overhead than Worker Threads (~50-200 ms for process creation)
- No shared memory with Main Process (no `SharedArrayBuffer` across process boundary)
- Data transfer requires serialization or `Transferable` transfer (moves ownership, does not share)
- Cannot communicate directly with Renderer Processes; must relay through Main Process (or use `MessagePort` forwarding, which adds complexity)
- Relatively new API; fewer production references than Worker Threads
- Each UtilityProcess has its own V8 heap and native memory; higher total memory footprint than Worker Threads for equivalent workloads

**Relevance to duckspace:**
UtilityProcess provides crash isolation -- a DuckDB segfault in a UtilityProcess would not crash the entire app. However, the inability to share memory and the overhead of data transfer (especially for large Arrow buffers) makes it less suitable for the high-throughput Arrow data plane that duckspace requires.

### 1.5 Web Workers (Renderer-side)

Web Workers run JavaScript threads within the Renderer Process. They have no access to the DOM but can perform computation and communicate via `postMessage`.

**Capabilities:**
- Off-main-thread computation in the renderer
- Can use `SharedArrayBuffer` with the renderer's main thread
- Can use `OffscreenCanvas` for off-thread rendering (limited browser support in Electron)
- Lightweight to spawn

**Limitations:**
- Cannot load native Node.js modules
- Isolated to the renderer's web platform sandbox
- Communication with Main Process requires routing through the renderer's main thread and IPC

**Relevance to duckspace:**
Web Workers are useful for client-side data preparation (e.g., preparing Arrow record batches for Perspective.js, computing layout for Observable Plot). They should not host databases or heavy computation -- that belongs in Worker Threads on the Node.js side.

---

## 2. Inter-Process Communication (IPC)

### 2.1 ipcMain / ipcRenderer (Electron built-in)

The standard Electron IPC mechanism. With context isolation enabled:

- **Renderer to Main:** `ipcRenderer.invoke(channel, ...args)` returns a Promise; Main handles via `ipcMain.handle(channel, handler)`
- **Main to Renderer:** `webContents.send(channel, ...args)`; Renderer listens via `ipcRenderer.on(channel, listener)`
- **Serialization:** Uses Chromium's structured clone algorithm. Supports `ArrayBuffer` transfer (zero-copy move), `SharedArrayBuffer`, `MessagePort`, typed arrays, `Date`, `RegExp`, `Map`, `Set`, `Error`, and nested objects.

**Performance characteristics:**
- Small messages (<1 KB): ~0.1-0.5 ms round-trip
- Transferable ArrayBuffer (1 MB): ~0.2-1.0 ms (near zero-copy; ownership transfer)
- Structured clone of 1 MB object: ~2-10 ms (serialization + deserialization)

**Arrow buffer transfer:**
Apache Arrow IPC buffers are `ArrayBuffer` instances. Using the `Transferable` mechanism, Arrow buffers can be moved from Main Process to Renderer with negligible overhead -- the buffer's backing memory is transferred, not copied. This is critical for duckspace's "Arrow-First Data Flow" principle.

### 2.2 contextBridge

`contextBridge.exposeInMainWorld(apiKey, api)` creates a secure bridge between the preload script (which has access to Node.js/Electron APIs) and the renderer's web context.

**Overhead analysis:**
- contextBridge wraps exposed functions with Proxy objects that enforce structured clone on all arguments and return values
- This means every call through contextBridge performs serialization/deserialization
- For small, infrequent calls (UI actions, configuration): negligible overhead
- For high-frequency data transfer: the structured clone overhead is identical to standard IPC -- contextBridge does not add extra serialization beyond what `ipcRenderer.invoke` already does
- `Transferable` support works through contextBridge (Arrow buffers can be transferred)

**Conclusion:** contextBridge overhead is negligible for duckspace's use case. The alternative (disabling context isolation) is a security anti-pattern and has been deprecated as a default in modern Electron. Use contextBridge unconditionally.

### 2.3 MessagePort (MessageChannelMain)

Electron's `MessageChannelMain` creates a pair of `MessagePort` objects that can be transferred to different processes, enabling direct communication channels.

**Key capability:** A `MessagePort` can be sent from Main Process to a Renderer Process and another port from the same channel to a Worker Thread. This establishes a **direct renderer-to-worker communication channel** that bypasses the Main Process for data transfer.

**Architecture implication for duckspace:**
1. Main Process creates a `MessageChannelMain` pair
2. One port is sent to the Renderer via `webContents.postMessage`
3. The other port is sent to the Worker Thread hosting DuckDB
4. The Renderer sends query requests directly to the Worker Thread
5. The Worker Thread sends Arrow result buffers directly back to the Renderer
6. Main Process is not in the data path -- only in the control path (lifecycle, configuration)

This is the optimal topology for duckspace: Main Process handles orchestration and lifecycle, Worker Threads handle database queries and computation, and data flows directly between Worker Thread and Renderer without Main Process bottleneck.

### 2.4 MessagePort Limitations

- MessagePort uses structured clone (same as IPC); `Transferable` ArrayBuffers work
- No `SharedArrayBuffer` across MessagePort between different process types (Main-to-Renderer boundary is a process boundary)
- MessagePort channels are one-to-one; broadcasting requires multiple channels or a relay
- Error handling is limited (port disconnection detection requires polling or heartbeat patterns)

---

## 3. Memory Management

### 3.1 V8 Heap Limits

Each V8 isolate (Main Process, each Worker Thread, each Renderer) has its own heap:

| Process | Default Heap Limit | Configurable? |
|---------|-------------------|---------------|
| Main Process | ~1.5 GB (64-bit) | Yes, via `--max-old-space-size` in app flags |
| Worker Thread | ~1.5 GB | Yes, via `resourceLimits` option at creation |
| Renderer | ~1.5 GB | Yes, via Chromium flags |
| UtilityProcess | ~1.5 GB | Yes, via Electron API |

For duckspace, V8 heap usage should remain low because the "Stream and Scan" principle prohibits loading full datasets into JS memory. DuckDB and LanceDB manage their own native memory outside V8's heap.

### 3.2 Native Memory (Outside V8)

DuckDB, LanceDB, and Arrow all allocate memory outside V8's managed heap:

- **DuckDB:** Uses its own buffer manager with configurable memory limits. Allocates native memory for query execution, result materialization, and temporary storage.
- **LanceDB:** Uses Arrow-rs memory allocator. Vector indices are memory-mapped from disk.
- **Arrow (Node.js bindings):** `ArrayBuffer` backing stores are allocated outside V8 heap but tracked by V8 for GC purposes.

**Key insight:** Native memory from database engines in a Worker Thread shares the same OS process address space as the Main Process. A memory leak in a DuckDB Worker Thread eventually affects the entire application. Monitor native memory via `process.memoryUsage()` (specifically `rss` and `external`).

### 3.3 Memory Pressure Strategies

- Set explicit DuckDB memory limits via `SET memory_limit='2GB'`
- Configure LanceDB to use memory-mapped I/O for indices (avoids loading into heap)
- Use `Transferable` for Arrow buffers to avoid duplication (transfer moves ownership)
- Implement buffer pooling for frequently-allocated Arrow buffers
- Monitor `process.memoryUsage().external` for native memory tracking

---

## 4. Electron v28+ Features Relevant to duckspace

### 4.1 WebGPU Support

Electron v28+ ships with WebGPU enabled (via Dawn). This enables GPU-accelerated computation and rendering in the Renderer Process:
- Perspective.js can leverage WebGPU for large dataset rendering
- Custom compute shaders for data aggregation (future optimization)
- WebGPU is renderer-only; not available in Worker Threads or Main Process

### 4.2 ESM Support in Main Process

Electron v28+ supports ES modules in the Main Process. This enables:
- Using `import` syntax natively
- Loading ESM-only packages without bundler workarounds
- Consistent module system between Main Process and Renderer

### 4.3 Context Isolation and Sandbox Defaults

Electron v28+ defaults:
- `contextIsolation: true` (preload runs in isolated world)
- `sandbox: true` (renderer cannot access Node.js)
- `nodeIntegration: false`

These defaults align with duckspace's architecture: Renderer is a pure web environment; all Node.js/native work happens in Main Process or Worker Threads.

### 4.4 UtilityProcess Improvements

Electron v28+ has improved UtilityProcess stability and added features:
- Better native module loading support
- Improved MessagePort handling
- stdio access for debugging

### 4.5 V8 and Node.js Updates

Electron v28+ ships with Node.js 18+ and V8 11.x+:
- Improved `structuredClone` performance
- Better `Transferable` support
- `AbortSignal` improvements for cancellable operations
- `worker_threads` stability improvements

---

## 5. Trade-off Analysis

### 5.1 UtilityProcess vs Worker Thread for Database Hosting

| Criterion | Worker Thread | UtilityProcess |
|-----------|--------------|----------------|
| **Spawn time** | ~5-30 ms | ~50-200 ms |
| **Crash isolation** | No (crashes app) | Yes (separate process) |
| **SharedArrayBuffer** | Yes (same process) | No (cross-process) |
| **Transferable perf** | Near-instant (same address space) | Fast (cross-process IPC) |
| **Native module loading** | Yes | Yes |
| **Memory overhead** | Lower (shared address space) | Higher (separate process) |
| **MessagePort to Renderer** | Yes (via MessageChannelMain) | Yes (via Main relay) |
| **Direct Renderer comms** | Yes | No (must proxy through Main) |
| **Debugging** | Harder (same process) | Easier (separate process, stdio) |
| **Memory limit independence** | Partial (separate V8 heap, shared native) | Full (separate process) |

**Verdict:** Worker Thread is the better choice for duckspace.

**Rationale:**
1. **Performance:** Worker Threads enable SharedArrayBuffer and near-instant Transferable transfer. For an app built around Apache Arrow zero-copy IPC, this is the deciding factor.
2. **Direct Renderer communication:** MessagePort from Worker Thread to Renderer bypasses the Main Process for data transfer, reducing latency and Main Process load.
3. **Lower overhead:** Fewer processes means lower total memory footprint and simpler process lifecycle management.
4. **Crash risk mitigation:** DuckDB's native addon is mature and stable. The probability of native segfault is low. If crash isolation becomes necessary later, specific operations can be moved to UtilityProcess without redesigning the entire architecture.
5. **"Stream and Scan" alignment:** Worker Threads can stream Arrow buffers to the Renderer as they are produced, without buffering entire result sets.

### 5.2 contextBridge Overhead vs Direct IPC

| Approach | Security | Overhead | Maintenance |
|----------|----------|----------|-------------|
| **contextBridge (recommended)** | High (enforced isolation) | Negligible (same structured clone as IPC) | Low (standard Electron pattern) |
| **Disabled context isolation** | Low (renderer has Node.js access) | None | High (security audit burden) |
| **Custom preload without contextBridge** | Medium | Low | High (manual serialization) |

**Verdict:** Use contextBridge unconditionally.

contextBridge does not add measurable overhead beyond what IPC already requires. Disabling context isolation to avoid contextBridge is a security regression with no performance benefit. The Electron team has moved toward making context isolation mandatory; designs that depend on its absence are not forward-compatible.

### 5.3 Single Renderer vs Multi-Window Architecture

| Approach | Pros | Cons |
|----------|------|------|
| **Single Renderer** | Simpler state management; lower memory; shared WebGPU context | All views compete for one V8 heap; large DOM may cause jank |
| **Multi-Window** | Independent V8 heaps; crash isolation between views; native macOS windowing | Complex state synchronization; higher memory; MessagePort/IPC overhead between windows |
| **Single Renderer + Web Workers** | Main thread stays responsive; computation offloaded | Still one V8 heap; Web Workers cannot access DOM |

**Verdict:** Start with a single Renderer Process, use Web Workers for heavy renderer-side computation.

**Rationale:**
1. duckspace is single-user, single-focus. Multi-window adds complexity without clear user benefit for the initial design.
2. Perspective.js manages its own rendering pipeline and handles large datasets efficiently. A single renderer with Perspective.js and Web Workers is sufficient.
3. If a "detach chart" feature is needed later, individual charts can be moved to separate BrowserWindows. This is an additive change, not a redesign.
4. State synchronization between multiple renderers (e.g., shared query results, shared catalog state) would require a pub/sub layer that adds significant complexity.

---

## 6. Worker Thread Architecture Patterns

### 6.1 Dedicated Worker Pattern (Recommended)

Assign each database engine its own dedicated Worker Thread:

| Worker Thread | Responsibility | Native Module |
|---------------|---------------|---------------|
| **DuckDB Worker** | SQL query execution, data scanning, aggregation | `duckdb` (N-API addon) |
| **LanceDB Worker** | Vector search, embedding storage, index management | `vectordb` (N-API addon) |
| **Computation Worker** | Arrow transformations, data prep, export pipeline | `apache-arrow` |

**Why dedicated workers:**
- Each database engine has its own memory management; isolation prevents interference
- Different workload patterns (DuckDB: bursty queries; LanceDB: sustained index operations)
- Independent lifecycle management (restart one worker without affecting others)
- Cleaner error boundaries

### 6.2 RxDB Placement

RxDB with the SQLite adapter runs in the Main Process (not a Worker Thread):
- RxDB manages UI state (catalog metadata, user preferences, query history) -- small, frequent reads
- RxDB's change stream feeds the Renderer's reactive UI via IPC events
- SQLite operations are fast for the small data volumes RxDB handles
- Running RxDB in the Main Process simplifies change notification dispatch to all renderers

### 6.3 Communication Topology

```
Renderer Process                  Main Process                  Worker Threads
+------------------+              +------------------+          +------------------+
|                  |              |                  |          |                  |
|  Perspective.js  |<--MessagePort-->                |          |  DuckDB Worker   |
|  Observable Plot |              |  ipcMain         |<-------->|  (query exec)    |
|  ECharts         |              |  (control plane) |          |                  |
|                  |              |                  |          +------------------+
|  Web Workers     |              |  RxDB (SQLite)   |          +------------------+
|  (data prep)     |              |  (state mgmt)    |          |                  |
|                  |              |                  |<-------->|  LanceDB Worker  |
|  contextBridge   |<--IPC------->|  Lifecycle mgmt  |          |  (vector search) |
|  (control API)   |              |                  |          |                  |
+------------------+              +------------------+          +------------------+
                                                                +------------------+
                   <----------MessagePort (data plane)--------->|  Compute Worker  |
                                                                |  (Arrow xforms)  |
                                                                +------------------+
```

**Data plane (hot path):** Renderer <--MessagePort--> Worker Threads. Arrow buffers transferred directly. Main Process is not in the data path.

**Control plane (cold path):** Renderer <--ipcMain--> Main Process. Configuration, lifecycle commands, catalog updates, error reporting. Small JSON payloads; overhead is irrelevant.

---

## Recommendation

### Recommended Process Topology for duckspace

**Architecture:** Single Renderer + Main Process + 3 Dedicated Worker Threads

| Component | Process | Rationale |
|-----------|---------|-----------|
| **UI / Visualization** | Renderer Process | Perspective.js, Observable Plot, ECharts render in DOM; WebGPU available |
| **Client-side data prep** | Renderer Web Workers | Offload Arrow buffer preparation from renderer main thread |
| **Application lifecycle** | Main Process | Window management, IPC dispatch, global configuration |
| **RxDB (catalog/state)** | Main Process | Small state DB; change streams feed renderer reactively |
| **DuckDB** | Worker Thread #1 | SQL query execution; Arrow result buffers transferred to renderer via MessagePort |
| **LanceDB** | Worker Thread #2 | Vector search; embedding operations; index management |
| **Computation** | Worker Thread #3 | Data transformation, export pipeline, ingestion processing |

**Communication:**
- **Data plane:** MessagePort channels between Renderer and each Worker Thread. Arrow `ArrayBuffer` instances are transferred (zero-copy ownership move), never copied.
- **Control plane:** Standard Electron IPC (`ipcMain.handle` / `ipcRenderer.invoke`) through contextBridge. Used for lifecycle, configuration, catalog operations, error reporting.
- **Internal (Main-to-Worker):** `worker_threads` `MessagePort` with Transferable Arrow buffers. Used for orchestration (e.g., Main tells DuckDB Worker to execute a query initiated by a connector, then routes the result to the Renderer).

**Key design decisions:**
1. Worker Threads over UtilityProcess for database hosting (performance wins outweigh crash isolation)
2. contextBridge unconditionally (no security compromises for negligible overhead)
3. Single Renderer with Web Workers (complexity-appropriate for single-user desktop app)
4. MessagePort for direct Renderer-to-Worker data transfer (Main Process stays responsive)
5. Dedicated workers per database engine (isolation, independent lifecycle, clean error boundaries)

---

## Alternatives Considered

### Alternative 1: UtilityProcess for Database Hosting

**Description:** Run DuckDB and LanceDB in separate UtilityProcess instances instead of Worker Threads.

**Advantages:**
- Crash isolation: a DuckDB segfault would not crash the application
- Independent memory limits: each process has fully separate address space
- Easier debugging with separate process stdio

**Why rejected:**
- No SharedArrayBuffer across process boundary; Arrow zero-copy transfer requires Transferable (ownership move), not sharing
- Cannot establish direct MessagePort between UtilityProcess and Renderer; all data must proxy through Main Process
- Higher spawn overhead and memory footprint
- The "Arrow-First Data Flow" principle demands minimal transfer overhead; Worker Thread's same-address-space Transferable is faster

**When to reconsider:** If DuckDB native module stability becomes a concern (repeated crashes), move DuckDB to UtilityProcess and accept the proxy overhead. This is an incremental change.

### Alternative 2: Multi-Renderer Architecture

**Description:** Each major view (query editor, dashboard, catalog) runs in its own BrowserWindow with its own Renderer Process.

**Advantages:**
- Independent V8 heaps per view
- Crash isolation between views
- Native macOS multi-window experience

**Why rejected:**
- Complex state synchronization between renderers
- Higher total memory usage (each renderer loads its own copy of Perspective.js, etc.)
- MessagePort channels between renderers require Main Process coordination
- Single-user desktop app does not benefit from multi-window complexity in initial design
- Can be added incrementally later (e.g., "detach chart to new window")

### Alternative 3: All Computation in Main Process

**Description:** Run DuckDB, LanceDB, and all computation directly on the Main Process event loop, using async APIs.

**Advantages:**
- Simplest architecture; no Worker Thread management
- No IPC overhead for database access

**Why rejected:**
- Violates Constitution principle #12 (Process Isolation)
- Even async database operations have synchronous phases that block the event loop
- Main Process blocking causes window management freezes (unresponsive UI)
- No path to concurrent query execution

### Alternative 4: Child Process (fork) Instead of Worker Thread

**Description:** Use Node.js `child_process.fork()` for database workers instead of `worker_threads`.

**Advantages:**
- Full process isolation (like UtilityProcess)
- Standard Node.js API, well-documented

**Why rejected:**
- `child_process.fork()` in Electron has complications (forked process may not have correct Electron environment)
- UtilityProcess is Electron's official replacement for `child_process.fork()` in production apps
- Same cross-process limitations as UtilityProcess (no SharedArrayBuffer, no direct Renderer MessagePort)
- If process isolation is needed, UtilityProcess is the correct Electron-native choice

### Alternative 5: Single Worker Thread for All Databases

**Description:** Host DuckDB, LanceDB, and computation tasks in a single Worker Thread.

**Advantages:**
- Lower total memory overhead (one V8 isolate instead of three)
- Simpler lifecycle management

**Why rejected:**
- A long-running DuckDB query blocks LanceDB vector search operations
- No independent restart capability (restarting for one engine kills all)
- Harder to set per-engine memory limits
- Violates the principle that different workload patterns should be isolated

---

## References

- [Electron Process Model documentation](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron UtilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron MessageChannelMain API](https://www.electronjs.org/docs/latest/api/message-channel-main)
- [Electron contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge)
- [Node.js worker_threads documentation](https://nodejs.org/api/worker_threads.html)
- [Electron v28 release notes](https://www.electronjs.org/blog/electron-28-0)
- [DuckDB Node.js API](https://duckdb.org/docs/api/nodejs/overview)
- [Apache Arrow JavaScript documentation](https://arrow.apache.org/docs/js/)
