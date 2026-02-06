# ADR-001: Embedded Database Trio Architecture

**Status:** Accepted (Revised)
**Date:** 2026-02-04
**Revision:** 2 -- Replaced RxDB Premium with Dexie.js (free alternative)
**Deciders:** datspace Architecture Team
**Domain:** System Design -- Database Layer

---

## Context

datspace is an Electron-based desktop analytics application designed for single-user, local-first, macOS-first operation. The application must handle three fundamentally different data workloads:

1. **Analytical queries on columnar data (OLAP).** Users import CSV, Parquet, and JSON files and run aggregations, joins, scans, and filters over potentially large datasets (millions of rows). This workload demands a columnar OLAP engine with vectorized execution, predicate pushdown, and native Apache Arrow output.

2. **Vector search and full-text search.** datspace includes an AI/RAG pipeline that requires storing document embeddings, performing k-nearest-neighbor similarity search, running full-text search over document content, and supporting hybrid search (vector + FTS). This workload demands a purpose-built vector database with index support and streaming scan capability.

3. **Reactive UI state and metadata catalog.** The application UI needs observable, push-based queries for dashboard layouts, data source metadata, chat history, user preferences, and column statistics. This workload demands a reactive document store with schema migration support, efficient change detection, and direct React integration.

### Why No Single Database Can Serve All Three Roles

- **DuckDB** excels at OLAP but has no reactive query subscriptions, no vector index, and no full-text search engine suitable for RAG.
- **LanceDB** excels at vector search and FTS but has limited analytical SQL capabilities (no complex joins, no window functions, no OLAP optimizer).
- **Dexie.js** excels at reactive state with `liveQuery()` but stores data in IndexedDB, which is not suitable for analytical scans over millions of rows or vector similarity search.

A three-database architecture is the minimal configuration that serves all three workloads without forcing any engine outside its design parameters.

The project constitution (Principles 9-14) imposes additional constraints:
- **Arrow-First Data Flow** (Principle 9): All inter-component data transfer must use Apache Arrow.
- **Embedded-Only Databases** (Principle 10): No external database servers; all databases run in-process within Electron.
- **Stream and Scan** (Principle 11): Never load full datasets into JavaScript memory.
- **Process Isolation** (Principle 12): Main Process owns database engines; Worker Threads isolate heavy computation.
- **macOS-First** (Principle 13): All technology choices must work on macOS with Electron.
- **Single-User, Local-First** (Principle 14): No multi-user sync or authentication.

---

## Decision

We adopt a three-database embedded architecture, using only free and open-source components:

| Role | Database | License | Workload |
|------|----------|---------|----------|
| Analytical engine | DuckDB (native addon) | MIT | OLAP queries, columnar scans, aggregations, joins |
| Vector and FTS engine | LanceDB (N-API addon) | Apache 2.0 | Vector similarity search, full-text search, hybrid search |
| Reactive state layer | Dexie.js (IndexedDB) | MIT | UI state, metadata catalog, chat history, preferences |

### DuckDB Configuration

- **Deployment mode:** Native Node.js addon (`duckdb` npm package, via `duckdb-node`), not WASM.
- **Hosting:** Dedicated Worker Thread spawned from the Main Process. The Worker Thread owns the DuckDB database instance and executes all queries. Results are returned as Apache Arrow IPC buffers transferred via `postMessage` with `transferList` (zero-copy).
- **Memory limit:** 50% of system RAM (configurable by user). Spill-to-disk enabled via `temp_directory` set to app data directory.
- **Thread pool:** System cores minus 2, leaving headroom for Main Process and Renderer.
- **Extensions bundled:** parquet, json, httpfs, icu (approximately 23 MB additional to core library).
- **Result format:** Streaming Arrow IPC by default. DuckDB streams Arrow record batches (1024-2048 rows per chunk) to keep memory usage bounded regardless of result set size. Materialized results only for small lookup or metadata queries.
- **Concurrency:** Multiple concurrent readers (MVCC), single writer. Write operations serialized through the Worker Thread's query queue.
- **Query cancellation:** DuckDB supports query interruption via `duckdb_interrupt`. The Worker Thread exposes a cancel mechanism for long-running queries.

### LanceDB Configuration

- **SDK:** `@lancedb/lancedb` npm package (native N-API addon compiled from Rust). Prebuilt binaries available for macOS arm64 and x64; `electron-rebuild` not required due to N-API ABI stability.
- **Hosting:** LanceDB connection owned by the Main Process. Embedding computation runs in a separate Worker Thread; write requests are sent to Main Process via MessagePort.
- **Vector index defaults:**

| Collection Size | Index Type | Rationale |
|----------------|-----------|-----------|
| < 5K vectors | No index (brute force) | 100% recall, negligible latency |
| 5K - 50K vectors | IVF_FLAT | Exact search within partitions, fast build |
| > 50K vectors | IVF_PQ or IVF_HNSW_SQ | Memory-efficient with high recall |

Index type can be changed without data migration -- only a rebuild is required.

- **Full-text search:** Tantivy-based FTS engine integrated into LanceDB. BM25 scoring. FTS indexes created on all searchable text columns at table creation time.
- **Hybrid search:** Reciprocal Rank Fusion (RRF) combining vector similarity and FTS relevance scores. Configurable weighting between vector and text components.
- **Storage format:** Lance columnar format (Arrow-native, versioned, fragment-based). Copy-on-write versioning with configurable retention (keep last 10 versions).
- **Compaction:** Automatic on app idle or when fragment count exceeds 50. Run via `table.optimize()` in a background Worker Thread.
- **Embedding pipeline:** Separate from LanceDB (not using LanceDB built-in embedding functions). Batch insertion (256-1024 vectors) for bulk ingestion; micro-batch (16-64 vectors) for real-time RAG interactions.

### Dexie.js Configuration

- **Package:** `dexie` (~3.5M weekly npm downloads, 11K+ GitHub stars, MIT license) with `dexie-react-hooks` (~3 KB) for React integration.
- **Hosting:** Runs in the **Renderer Process** using Chromium's native IndexedDB implementation. No native addons, no WASM, no compilation step. Total bundle impact: ~83 KB minified (~27 KB gzipped).
- **Reactive queries:** Dexie.js 3.x+ provides `liveQuery()` which turns any Dexie query into a push-based reactive observable. The library tracks which object stores and index ranges each query function reads, then automatically re-evaluates only when a write operation affects those ranges. Rapid successive writes are debounced before re-evaluation. Cross-tab/cross-worker change propagation is built-in via IndexedDB change events.
- **React integration:** The `useLiveQuery` hook from `dexie-react-hooks` integrates directly with React's rendering cycle. Components automatically re-render when their subscribed data changes:

```typescript
import { useLiveQuery } from 'dexie-react-hooks';

function DashboardList() {
  const dashboards = useLiveQuery(
    () => db.dashboards.where('userId').equals('local').toArray()
  );
  // Automatically re-renders when dashboards change
}
```

- **Schema and migrations:** Version-based schema declarations. Only indexed properties are declared -- non-indexed properties are stored without declaration (schemaless documents). Migrations run within IndexedDB transactions via `upgrade()` functions.

```typescript
const db = new Dexie('Datspace');

db.version(1).stores({
  user_preferences: 'id',
  dashboards: 'id, name, createdAt, updatedAt',
  data_sources: 'id, name, type, createdAt',
  table_metadata: 'id, sourceId, name, [sourceId+name]',
  chat_conversations: 'id, createdAt, updatedAt',
  chat_messages: 'id, conversationId, timestamp, [conversationId+timestamp]',
  query_history: 'id, timestamp, *tags',
  column_statistics: 'id, tableId, [tableId+columnName]',
});
```

- **Data durability:** IndexedDB in Chromium stores data in LevelDB files on disk in Electron's user data directory. Transactions are atomic with WAL-like journaling for crash recovery. Committed data survives Renderer crashes.
- **Sync:** Disabled. No Dexie Cloud addon. Single-user, local-only.
- **Process model note:** Constitution Principle 12 states "Main Process owns database engines." Dexie.js runs in the Renderer, which is a documented and intentional deviation from Principle 12. See the Consequences section for full rationale.

### Lance DuckDB Extension

- **Decision:** Design the architecture to work without the Lance DuckDB extension, but leave room to adopt it when stable.
- **Current approach:** Use DuckDB's Arrow scan capability to import LanceDB query results as Arrow tables, then join/filter in DuckDB. This avoids dependency on the immature Lance extension while enabling cross-database analytical queries.
- **Dual-access pattern:** LanceDB API for vector search, FTS, hybrid search, and writes. DuckDB for analytical queries, aggregations, and joins over any data expressible as Arrow tables (including Lance data via the extension when mature).

**Query routing summary:**

| Query Type | Target Engine | Rationale |
|-----------|--------------|-----------|
| Analytical SQL | DuckDB (Worker Thread) | Columnar OLAP engine |
| Vector similarity search | LanceDB (Main Process) | Requires vector index |
| Full-text search | LanceDB FTS/hybrid (Main Process) | Requires Tantivy FTS index |
| Cross-database analytics | DuckDB + Arrow scan of Lance results | Analytical aggregation over vector metadata |
| UI state read/write | Dexie.js liveQuery (Renderer) | Reactive push-based queries |
| Dashboard layout, chat history | Dexie.js liveQuery (Renderer) | Reactive push-based queries |

---

## Alternatives

### DuckDB Alternatives

#### SQLite (as analytical engine) -- Rejected

SQLite is row-oriented and not optimized for analytical OLAP workloads. DuckDB's columnar vectorized engine provides 10-100x better performance for aggregations, scans, and joins on large datasets. SQLite lacks native Apache Arrow output, violating the Arrow-First Data Flow principle (Principle 9). Using SQLite for analytics would conflate the analytical and state workloads.

#### sql.js / duckdb-wasm -- Rejected

WASM-based database engines suffer from: 2-5x performance penalty versus native, 4GB memory ceiling (WASM32 address space), no memory-mapped file I/O, and Arrow IPC copies across the WASM/JS boundary (not zero-copy). For a macOS-first desktop application, the portability advantage of WASM is irrelevant, and the performance cost is unacceptable for analytical workloads.

#### DuckDB as Child Process -- Rejected

Running DuckDB in a separate child process (via `child_process.fork()`) requires IPC serialization for data transfer, making zero-copy Arrow buffer transfer impossible. File locking is also more complex across process boundaries. Worker Threads provide sufficient isolation with better data transfer characteristics.

#### ClickHouse Local (chdb) -- Rejected

Less mature than DuckDB for embedded use. DuckDB has superior Node.js bindings, better Apache Arrow integration, and a more active embedded/analytical community. ClickHouse is primarily designed as a server; embedded mode is secondary.

#### Polars (via Node.js bindings) -- Rejected

Polars is a DataFrame library, not a database. It lacks persistent storage, SQL interface, and MVCC concurrency. Could complement DuckDB via Arrow interop but cannot replace it as the primary analytical engine.

### LanceDB Alternatives

#### Chroma (chromadb) -- Rejected

Chroma's default architecture is client-server, requiring a running Chroma server process. This violates the Embedded-Only Databases principle (Principle 10). While Chroma has an experimental embedded mode, it lacks Arrow-native integration (violating Principle 9) and has no DuckDB interoperability. Its Node.js SDK is an HTTP client, not an in-process addon.

#### Qdrant -- Rejected

Qdrant is a standalone Rust server requiring a separate process. No embeddable mode exists for Node.js. This directly violates the Embedded-Only Databases principle. While Qdrant offers excellent performance as a server, the architectural constraint is non-negotiable.

#### SQLite-VSS (sqlite-vss) -- Rejected

Embeddable and would fit the architecture, but lacks Arrow-native integration (requiring serialization in the hot path, violating Principle 9). Limited to IVF-only index type (Faiss-based), compared to LanceDB's IVF_PQ, IVF_FLAT, and IVF_HNSW_SQ. Sporadic maintenance from a sole maintainer. No DuckDB interoperability.

### Reactive State Layer Alternatives

#### RxDB Premium with SQLite Adapter -- Rejected (Paid License)

RxDB Premium was the recommendation in revision 1 of this ADR. It provides an excellent reactive query system (EventReduce algorithm, RxJS Observables) with a SQLite storage adapter that runs in the Main Process, fully aligning with Constitution Principle 12. However, **RxDB Premium requires a paid license (~$100-300/year)**. This cost dependency is rejected for datspace. The free community edition uses Dexie.js/IndexedDB internally, making RxDB Premium's unique value the SQLite adapter -- which is paywalled. Additionally, the paid license creates an ongoing budget dependency and licensing risk for an open-source project.

#### RxDB Community Edition (Free, Dexie backend) -- Rejected (Diminishing Returns)

RxDB Community uses Dexie.js/IndexedDB as its storage backend. Since Dexie 3.x introduced `liveQuery()` with native reactive queries, RxDB Community's added value is the EventReduce optimization algorithm and RxJS Observable integration. However, this comes at cost:
- ~100 KB additional bundle size beyond Dexie.js alone
- RxJS peer dependency (~30 KB)
- JSON Schema requirement for all collections
- Larger API surface and configuration complexity
- Runs in the same process (Renderer/IndexedDB) as plain Dexie.js -- no process model advantage
- 30K weekly npm downloads vs Dexie.js's 3.5M (smaller community)

The additional abstraction layer is not justified when Dexie provides reactive queries natively.

#### PouchDB -- Rejected (Wrong Tool)

PouchDB was designed for CouchDB sync -- a capability datspace does not need. It lacks native reactive queries (only low-level change feeds requiring manual query re-evaluation). Revision tracking and conflict resolution machinery add storage and processing overhead without benefit for a single-user local app. Performance degrades noticeably with tens of thousands of documents, which would affect `chat_messages` (up to 50K) and `column_statistics` (up to 100K) collections. Declining maintenance pace.

#### better-sqlite3 + Custom Reactive Layer -- Rejected (Engineering Cost)

better-sqlite3 runs natively in the Main Process (perfect Principle 12 alignment) and provides the fastest raw read/write performance of all candidates. However, it has zero reactive query support. Building a reliable reactive layer -- write interception, query subscription management, change-to-query mapping, React hooks integration, and IPC bridge from Main to Renderer -- is estimated at 20-36 engineering days and creates a perpetual maintenance burden. This custom code would be far less battle-tested than Dexie's `liveQuery()` used by millions of applications. Kept as a future optimization path if Dexie.js performance proves insufficient for specific high-write collections.

#### LokiJS -- Rejected (Durability and Maintenance)

In-memory document database with periodic full-database serialization to disk. Data between autosave intervals is lost on crash -- unacceptable for user data such as chat messages and metadata catalog entries. Full serialization becomes slow with large collections (100K documents). Effectively unmaintained (minimal GitHub commits in recent years, declining npm downloads from ~40K weekly).

#### electron-store -- Rejected (Insufficient)

Single JSON file key-value store. Cannot handle queryable indexed collections, has no reactive queries, and has a practical size limit under 10 MB. Only suitable for simple settings, not the state layer datspace requires.

---

## Consequences

### Process Model Constraints

The three-database architecture enforces a specific process topology:

```
Main Process (Node.js -- Coordinator)
  |
  +-- DuckDB Worker Thread
  |     - Loads duckdb native addon
  |     - Owns DuckDB instance and query execution
  |     - Returns Arrow IPC buffers via transferList (zero-copy)
  |
  +-- LanceDB Connection (in Main Process)
  |     - Owns LanceDB connection (single writer)
  |     - Handles vector search, FTS, hybrid search
  |     - Returns Arrow record batches
  |
  +-- Embedding Worker Thread
  |     - Computes embeddings (ONNX or remote API)
  |     - Sends vectors to Main Process for LanceDB insertion
  |
  +-- Background Maintenance Worker Thread
  |     - LanceDB compaction and index rebuilds
  |     - Scheduled on app idle
  |
  +-- IPC Bridge to Renderer
        - Forwards Arrow buffers from DuckDB/LanceDB to Renderer
        - Pushes metadata scan results to Renderer for Dexie storage

Renderer Process (Chromium)
  |
  +-- Dexie.js (IndexedDB)
  |     - Reactive UI state (liveQuery, useLiveQuery)
  |     - All app state collections
  |     - Persisted in Chromium's LevelDB (user data directory)
  |
  +-- React UI
  |     - Components subscribe via useLiveQuery
  |     - Receives Arrow buffers for visualization (Perspective.js)
  |
  +-- apache-arrow JS library
        - Deserializes Arrow IPC buffers from Main Process
```

**Principle 12 deviation rationale:** DuckDB and LanceDB are in the Main Process per Principle 12. Dexie.js runs in the Renderer, which is a documented deviation. This is architecturally sound because:
1. The reactive state layer manages UI state that is consumed by the Renderer -- it belongs close to the UI.
2. IndexedDB is Chromium's battle-tested browser-native storage API, designed for the Renderer process.
3. Reactive queries (`liveQuery`, `useLiveQuery`) work natively without IPC bridging, which is the primary use case.
4. The Renderer process persists for the application's lifetime (single-window desktop app).
5. App state can be rebuilt from DuckDB/LanceDB metadata if the Renderer crashes.
6. Constitution Principle 12 targets heavyweight engines (DuckDB, LanceDB) that need crash isolation and resource management. The reactive state layer manages small documents, not analytical data.

When the Main Process needs to update state (e.g., after a background metadata scan), it pushes data to the Renderer via standard Electron IPC. The Renderer writes to Dexie, which triggers reactive updates to subscribed components automatically.

### Memory Budget Allocation

On a 16 GB Mac (typical target):

| Component | Memory Budget | Notes |
|-----------|--------------|-------|
| DuckDB buffer pool | ~8 GB (50% of RAM) | Configurable via `memory_limit`; spills to disk |
| LanceDB operations | ~200-500 MB peak | Index builds are highest; queries use 10-50 MB |
| Dexie.js / IndexedDB | ~50-200 MB | Chromium manages IndexedDB memory; small documents |
| Electron + Renderer | ~500 MB - 1 GB | Chromium, V8, React, visualization |
| Arrow transfer buffers | Transient | Zero-copy transfer; buffers freed after consumption |
| OS and other apps | ~4-6 GB | Remaining headroom |

DuckDB dominates the memory budget as expected for an analytics application. LanceDB and Dexie.js operate within modest bounds for their workloads. Compared to the prior RxDB/SQLite configuration, Dexie.js/IndexedDB memory usage is managed by Chromium rather than explicitly configured -- Chromium's IndexedDB implementation handles its own memory allocation within the Renderer process budget.

### Query Routing Complexity

The application must route queries to the correct engine based on query type. A query routing layer in the Main Process classifies incoming requests and dispatches them to the appropriate engine. The routing logic is deterministic (not heuristic):

| Query Type | Target Database | Example |
|-----------|-----------------|---------|
| Analytical SQL | DuckDB (via Worker Thread) | `SELECT region, SUM(sales) FROM orders GROUP BY region` |
| Vector similarity search | LanceDB (via Main Process) | "Find documents similar to this embedding" |
| Full-text search | LanceDB (via Main Process) | "Search for 'revenue analysis'" |
| Hybrid search | LanceDB (via Main Process) | Vector + text combined search |
| Cross-database analytics | DuckDB + Arrow scan | "How many embeddings per data source?" |
| UI state read/write | Dexie.js (Renderer, direct) | "Save dashboard layout" |
| Reactive subscriptions | Dexie.js (Renderer, direct) | Dashboard list auto-updates on change |

Note: UI state queries via Dexie.js do not route through the Main Process at all. Dexie's `useLiveQuery` operates entirely within the Renderer, eliminating IPC overhead for the most frequent query pattern (reactive UI reads). This is a significant latency improvement over the prior architecture where RxDB in the Main Process required IPC bridging for every reactive subscription update.

### Migration and Upgrade Strategy

Each database has independent versioning and upgrade concerns:

**DuckDB:**
- Pin to a specific version in `package.json`.
- DuckDB catalog files are backward-compatible within major versions.
- Extensions must match the DuckDB version; bundle compatible extension binaries.
- Native addon must be rebuilt for each Electron version via `@electron/rebuild`.

**LanceDB:**
- Pin SDK version in `package.json`.
- Lance format is backward-compatible; schema evolution (add/drop columns) supported natively.
- Vector indexes can be rebuilt without data loss.
- Prebuilt N-API binaries provide ABI stability across Electron versions; rebuild typically not needed.

**Dexie.js:**
- npm update; no native compilation step.
- Dexie's `version().upgrade()` handles schema migrations transactionally within IndexedDB.
- Adding new collections or indexes is declarative and additive.
- IndexedDB data lives in Electron's profile directory (`app.getPath('userData')`) and persists across app updates.

**Coordinated upgrades:**
- Electron version upgrades require rebuilding the DuckDB native addon (LanceDB N-API and Dexie.js are unaffected).
- Application data is stored under `app.getPath('userData')`. All three databases store files under this path, making backup a single-directory operation.
- The app should implement a startup health check that verifies all three databases can open successfully before presenting the UI.

### Tradeoffs: Dexie.js vs RxDB Premium

Choosing Dexie.js (free) over the prior RxDB Premium recommendation introduces specific tradeoffs:

| Dimension | Dexie.js (chosen) | RxDB Premium (rejected) |
|-----------|-------------------|------------------------|
| **Cost** | Free (MIT) | ~$100-300/year |
| **Reactive queries** | liveQuery() -- efficient, built-in | EventReduce -- more sophisticated optimization |
| **Storage backend** | IndexedDB (Renderer) | SQLite (Main Process) |
| **Process alignment** | Renderer (Principle 12 deviation) | Main Process (full compliance) |
| **Raw performance** | Good (IndexedDB in Chromium) | Better (SQLite is faster for reads/writes) |
| **React integration** | useLiveQuery (direct, zero IPC) | Via RxJS subscription adapters + IPC bridge |
| **Bundle size** | ~83 KB | ~200 KB+ (RxDB + RxJS + SQLite addon) |
| **Schema enforcement** | Index declarations only (flexible) | JSON Schema required (strict) |
| **Community** | 3.5M weekly downloads | 30K weekly downloads |
| **IPC for UI reads** | None (Renderer-native) | Required (Main Process to Renderer) |
| **Native addon** | None | better-sqlite3 (~2 MB, requires rebuild) |

The key tradeoff is **process model purity vs zero cost and simplicity**. RxDB Premium would place the reactive state layer in the Main Process (fully aligned with Principle 12) with a faster SQLite backend. Dexie.js places it in the Renderer (pragmatic deviation) with IndexedDB, but eliminates IPC bridging for reactive queries -- the most frequent operation. For datspace's use case (small-to-moderate UI state documents in a single-user desktop app), this tradeoff favors Dexie.js.

### Bundle Size Impact

| Component | Approximate Size | Notes |
|-----------|-----------------|-------|
| Electron | 150-200 MB | Baseline |
| DuckDB core + addon | 30-50 MB | Native library |
| DuckDB extensions | ~23 MB | parquet, json, httpfs, icu |
| LanceDB N-API addon | ~15-25 MB | Rust-compiled native addon |
| Dexie.js + React hooks | ~83 KB | No native addons |
| apache-arrow JS library | ~500 KB | Arrow deserialization in Renderer |
| **Total application** | **~220-300 MB** | Comparable to other Electron analytics apps |

Dexie.js's bundle impact (~83 KB) is negligible -- 0.01% of total app size. This is lighter than the prior RxDB/SQLite configuration which included RxDB JS bundle (~108 KB) plus better-sqlite3 native addon (~2 MB).

### Future Optimization Path

If Dexie.js/IndexedDB performance proves insufficient for specific use cases:

1. **Targeted SQLite migration:** Move high-write collections (chat_messages, column_statistics) to better-sqlite3 in the Main Process with a custom IPC bridge, while keeping low-write reactive collections in Dexie.js.
2. **RxDB Community layering:** If reactive query complexity grows, RxDB Community can be layered on top of Dexie.js for its EventReduce algorithm without changing the storage backend.
3. **Dexie 4.x adoption:** The upcoming Dexie 4.x release promises further performance improvements and reactive query enhancements.

### Risk Summary

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| DuckDB native addon ABI mismatch on Electron upgrade | Medium | High | Pin versions; use `@electron/rebuild`; test in CI |
| DuckDB crashes in Worker Thread | Low | Medium | Worker crash detection + auto-respawn in Main Process |
| LanceDB prebuilt binary missing for new Electron | Low | Medium | N-API provides ABI stability; fallback to compilation |
| Lance DuckDB extension too immature to use | Medium | Low | Architecture works without it; Arrow scan as fallback |
| Dexie.js IndexedDB performance insufficient at scale | Low | Medium | Targeted SQLite migration for hot collections |
| IndexedDB storage limits in Electron | Very Low | Low | Electron apps get generous storage; monitor with `navigator.storage.estimate()` |
| Three-database query routing complexity | Certain | Medium | Clean routing layer; each engine has clear responsibility |
| Dexie.js maintenance risk | Very Low | Low | 3.5M weekly downloads; MIT license allows forking |

---

*ADR-001 Revised 2026-02-04. Replaces revision 1 which recommended RxDB Premium with SQLite adapter. The trio is now DuckDB + LanceDB + Dexie.js -- all free and open-source.*
