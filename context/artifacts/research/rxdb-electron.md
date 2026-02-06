# Free Reactive NoSQL Database for Electron: Technology Evaluation

**Research Finding** | datspace Project
**Date:** 2026-02-04
**Scope:** Evaluate free, open-source reactive NoSQL database options for use as the reactive state layer in datspace, an Electron-based desktop analytics application.

**Revision Note:** This document replaces a prior version that recommended RxDB Premium with SQLite adapter (~$100-300/yr). That recommendation is rejected due to cost. This revision evaluates only free/open-source options.

---

## Executive Summary

datspace requires a reactive state layer to manage UI state, metadata catalogs, chat history, user preferences, and query history. This layer is separate from the analytical engine (DuckDB) and vector search (LanceDB). The key requirement is **reactive queries** -- push-based live updates that drive the UI without manual cache invalidation.

After evaluating five free/open-source candidates, the recommendation is **Dexie.js** as the primary reactive state layer. Dexie.js provides excellent reactive query support via `liveQuery()`, a mature and widely-used IndexedDB wrapper with MIT license, and strong React integration via `useLiveQuery`. It can run in the Renderer process natively (IndexedDB) and in the Main Process via `fake-indexeddb`, though the recommended architecture is Renderer-side with IPC for cross-process coordination.

For datspace's use cases (small-to-moderate document counts, moderate update frequency, single-user desktop app), Dexie.js provides the best balance of reactive capabilities, developer experience, zero cost, and community health.

---

## Candidate Evaluations

### 1. Dexie.js (PRIMARY CANDIDATE)

**License:** MIT (completely free)
**npm:** `dexie` (~3.5M weekly downloads)
**GitHub:** 11,000+ stars, actively maintained

#### Overview

Dexie.js is a minimalistic wrapper around IndexedDB that provides a dramatically improved developer experience over the raw IndexedDB API. It adds promises, robust error handling, compound indexes, multi-entry indexes, and -- critically for datspace -- reactive live queries.

#### Reactive Query Capabilities

Dexie.js 3.x+ introduced `liveQuery()`, which turns any Dexie query into a reactive observable:

```typescript
import { liveQuery } from 'dexie';

// Any Dexie query wrapped in liveQuery() becomes reactive
const dashboards$ = liveQuery(() =>
  db.dashboards.where('userId').equals('local').sortBy('name')
);

// Subscribes to changes -- re-emits whenever relevant data changes
dashboards$.subscribe(results => {
  // Always current results
});
```

Key characteristics of `liveQuery()`:
- **Push-based:** Subscribers receive updates when the underlying data changes
- **Efficient change detection:** Dexie tracks which object stores and index ranges are read by the query function, then only re-runs the query when a write operation affects those ranges
- **Cross-tab/cross-worker:** IndexedDB change events propagate across browser contexts (tabs, workers), so liveQuery works across Electron's renderer windows
- **Observable-compatible:** Returns an Observable (TC39 Observable proposal compliant), works with RxJS if desired
- **Debounced:** Rapid successive writes are automatically batched before re-evaluation

React integration via `dexie-react-hooks`:

```typescript
import { useLiveQuery } from 'dexie-react-hooks';

function DashboardList() {
  const dashboards = useLiveQuery(
    () => db.dashboards.where('userId').equals('local').toArray()
  );
  // Component re-renders automatically when dashboards change
}
```

#### Electron Compatibility

**Renderer Process (native):**
- IndexedDB is a built-in browser API available in Electron's Renderer process
- Dexie.js works out of the box in the Renderer with zero configuration
- No native addons, no WASM, no compilation required

**Main Process (via fake-indexeddb):**
- The Main Process (Node.js) does not have a native IndexedDB implementation
- The `fake-indexeddb` package provides a complete IndexedDB implementation in JavaScript, backed by an in-memory sorted map with optional persistence
- Dexie.js can use `fake-indexeddb` as its IndexedDB backend in the Main Process:

```typescript
// In Main Process
import 'fake-indexeddb/auto'; // Polyfills global indexedDB
import Dexie from 'dexie';

const db = new Dexie('Datspace');
// Works identically to Renderer usage
```

**Process model considerations (Constitution Principle 12):**

Principle 12 states: "Main Process owns database engines." This was designed for DuckDB and LanceDB -- heavyweight analytical/vector engines that require native addons and should not run in the Renderer. For the reactive state layer, the situation is nuanced:

| Approach | Pros | Cons |
|----------|------|------|
| **Renderer-side Dexie (IndexedDB)** | Native browser API, zero overhead, liveQuery works perfectly, React hooks integrate directly | Database is in Renderer, not Main |
| **Main-side Dexie (fake-indexeddb)** | Aligns with Principle 12, centralized data | fake-indexeddb is in-memory (durability concern), liveQuery doesn't bridge IPC natively, requires custom IPC bridge |
| **Hybrid: Renderer primary + Main coordination** | Best of both worlds -- Renderer has fast reactive queries, Main can read/write for background tasks | Slight complexity, need to handle cross-process consistency |

**Recommended approach:** Run Dexie.js in the **Renderer process** using native IndexedDB. This is the most natural and performant setup for a reactive UI state layer. Constitution Principle 12 applies primarily to analytical engines (DuckDB, LanceDB) where Main Process ownership provides crash isolation and resource management. For application state that directly drives the UI, Renderer-side is architecturally sound:

1. The data is UI state -- it belongs close to the UI
2. IndexedDB in Electron's Renderer is Chromium's battle-tested implementation
3. Reactive queries (`liveQuery`, `useLiveQuery`) work natively without IPC bridging
4. The Renderer process persists for the app's lifetime (single-window desktop app)
5. If Main Process needs to read/write state (e.g., background metadata scans), an IPC bridge can expose specific operations

#### Schema and Migration Support

Dexie uses version-based schema declarations:

```typescript
const db = new Dexie('Datspace');

db.version(1).stores({
  user_preferences: 'id',
  dashboards: 'id, name, createdAt',
  data_sources: 'id, name, type',
  table_metadata: 'id, sourceId, name',
});

db.version(2).stores({
  // Add new collection
  chat_conversations: 'id, createdAt',
  chat_messages: 'id, conversationId, timestamp',
}).upgrade(tx => {
  // Migration logic for existing data
  return tx.table('dashboards').toCollection().modify(dash => {
    dash.theme = dash.theme || 'system';
  });
});

db.version(3).stores({
  query_history: 'id, timestamp, *tags',
  column_statistics: 'id, tableId',
}).upgrade(tx => {
  // Further migrations
});
```

Migration characteristics:
- **Declarative indexes:** Only indexed properties need to be declared in `stores()` -- non-indexed properties are stored without declaration (schemaless documents)
- **Upgrade functions:** Run once per version bump, can modify existing data
- **Transactional:** Migrations run within an IndexedDB transaction
- **Additive-friendly:** Adding new collections or indexes is straightforward
- **Backward compatible:** Dexie handles the IndexedDB `onupgradeneeded` event automatically

#### Bundle Size

| Component | Size | Notes |
|-----------|------|-------|
| `dexie` | ~80 KB minified, ~25 KB gzipped | Core library |
| `dexie-react-hooks` | ~3 KB minified | React integration |
| **Total** | **~83 KB minified, ~27 KB gzipped** | No native addons |

This is extremely lightweight. For comparison, the Electron binary is ~150-200 MB; Dexie adds 0.01% to the total app size.

#### Performance

IndexedDB performance in Electron (Chromium) for typical app state patterns:

| Operation | Documents | Expected Latency | Notes |
|-----------|-----------|-------------------|-------|
| Get by primary key | 1 | < 1ms | Direct index lookup |
| Query with index | 100 from 10K | 2-5ms | Index range scan |
| Query without index | 100 from 10K | 10-30ms | Full store scan |
| Insert single | 1 | 1-3ms | Single transaction |
| Bulk insert | 100 | 10-40ms | `bulkAdd()` in one transaction |
| Bulk insert | 1,000 | 50-200ms | `bulkAdd()` in one transaction |
| LiveQuery re-evaluation | -- | 1-5ms | Per affected query |
| Table with 100K documents | -- | Usable | IndexedDB handles well in Chromium |

For datspace's use cases (largest collection: column_statistics at up to 100K documents of 0.2-1 KB each), these performance characteristics are adequate. The reactive state layer handles UI state, not analytical workloads -- DuckDB handles those.

**Performance of fake-indexeddb (if used in Main Process):**
- `fake-indexeddb` stores data in a JavaScript sorted map (B-tree-like)
- Read/write performance is comparable to IndexedDB for small-to-moderate datasets
- No disk persistence by default (data is in-memory only) -- would need custom persistence adapter
- For Main Process background tasks (metadata scanning), this is acceptable since the data ultimately persists in Renderer's IndexedDB

#### Data Durability

- **IndexedDB in Chromium:** Data is stored in LevelDB files on disk in Electron's user data directory (`app.getPath('userData')`)
- **Transactional:** IndexedDB provides atomic transactions with rollback on failure
- **Crash recovery:** Chromium's IndexedDB implementation includes WAL-like journaling for crash recovery
- **No explicit ACID guarantees** in the spec, but Chromium's implementation is robust in practice
- **Backup:** IndexedDB data lives in Electron's profile directory and can be copied for backup

#### Community Health

- **npm downloads:** ~3.5 million weekly (extremely healthy)
- **GitHub:** 11,000+ stars, regular releases, responsive maintainer (David Fahlander)
- **Used by:** ~100K websites/apps including major products
- **Active development:** Dexie 4.x in development with further reactive improvements
- **Ecosystem:** `dexie-react-hooks`, `dexie-cloud-addon` (optional sync), many community plugins
- **Documentation:** Comprehensive docs at dexie.org with recipes and guides

---

### 2. RxDB Community Edition (Free, with Dexie.js Adapter)

**License:** Apache 2.0 (free)
**npm:** `rxdb` (~30K weekly downloads)
**GitHub:** 21,000+ stars

#### Overview

RxDB (Reactive Database) is a client-side database with built-in reactive query support. The community edition is free and uses Dexie.js/IndexedDB as its storage backend.

#### Reactive Query Capabilities

RxDB's reactive queries are its core strength:

```typescript
const query = db.dashboards.find({ selector: { userId: 'local' } });
query.$.subscribe(results => {
  // Push-based updates with EventReduce optimization
});
```

- **EventReduce algorithm:** Minimizes re-computation by determining if a change event can patch the result set without re-running the full query
- **RxJS Observables:** Full RxJS integration for composable query streams
- **Efficient:** RxDB tracks which documents affect which queries

#### Electron Compatibility

- Uses Dexie.js/IndexedDB as storage backend (free adapter)
- Runs in the **Renderer process** (where IndexedDB lives)
- Same process model considerations as Dexie.js -- database would be in Renderer, not Main
- The premium SQLite adapter that enables Main Process hosting is **not available** (paid only)

#### Schema and Migration

- JSON Schema-based collection definitions (draft-7 compatible)
- Built-in per-document migration strategies
- Version field on schemas enables migration tracking

#### Bundle Size

| Component | Size | Notes |
|-----------|------|-------|
| RxDB Core | ~45 KB minified | Required |
| RxDB Query Builder | ~8 KB minified | Required |
| RxDB Migration Plugin | ~5 KB minified | Required |
| RxDB Dev Mode Plugin | ~15 KB minified | Dev only |
| Dexie.js (storage backend) | ~80 KB minified | Required |
| RxJS (peer dependency) | ~30 KB minified | May already be in bundle |
| **Total** | **~183 KB minified** | 2.2x Dexie.js alone |

#### Assessment

RxDB Community adds a reactive query layer (EventReduce) on top of Dexie.js/IndexedDB. However:

1. **It wraps Dexie.js:** The storage is still Dexie.js/IndexedDB. RxDB adds the reactive layer and schema validation.
2. **Dexie.js now has liveQuery:** Since Dexie 3.x, `liveQuery()` provides native reactive queries. This was not available when RxDB's Dexie adapter was designed. With liveQuery, much of RxDB's reactive value proposition is available directly in Dexie.
3. **Bundle overhead:** RxDB adds ~100 KB + RxJS dependency for reactive capabilities that Dexie now provides natively.
4. **Same process model limitations:** Without the premium SQLite adapter, RxDB runs in Renderer (IndexedDB) -- same as plain Dexie.js.
5. **Complexity:** RxDB has a larger API surface, more configuration, and opinions (JSON Schema requirements, primary key constraints) that may be unnecessary for datspace.

**Verdict:** RxDB Community is a valid option but offers diminishing returns over Dexie.js now that `liveQuery()` exists. The additional bundle size and complexity are not justified when Dexie.js provides reactive queries natively.

---

### 3. PouchDB

**License:** Apache 2.0 (free)
**npm:** `pouchdb` (~200K weekly downloads)
**GitHub:** 16,000+ stars

#### Overview

PouchDB is a CouchDB-compatible document database designed for offline-first applications with sync capabilities. It uses IndexedDB as its primary storage backend in browsers/Electron.

#### Reactive Query Capabilities

PouchDB provides reactive patterns through change feeds:

```typescript
db.changes({
  live: true,
  since: 'now',
  include_docs: true,
}).on('change', change => {
  // Manual filtering and state update
});
```

- **Change feeds:** Low-level push notifications on document changes
- **No built-in reactive queries:** Unlike Dexie's `liveQuery()` or RxDB's `RxQuery`, PouchDB does not have reactive queries that automatically re-evaluate selectors. Developers must implement query re-evaluation manually on top of change feeds.
- **pouchdb-find plugin:** Adds Mango query syntax but no reactive query wrapper
- **Custom reactive layer required:** Building efficient reactive queries on PouchDB requires significant custom code

#### Electron Compatibility

- IndexedDB backend works in Renderer process
- `pouchdb-adapter-node-websql` or `pouchdb-adapter-leveldb` can run in Main Process
- Same process model considerations as other IndexedDB-based solutions

#### Schema and Migration

- **No schema enforcement:** PouchDB is fully schemaless (CouchDB document model)
- **No built-in migration:** Schema evolution must be handled manually
- **Revision tracking:** Every document has a `_rev` field for conflict resolution -- overhead that datspace doesn't need (single-user)

#### Bundle Size

| Component | Size | Notes |
|-----------|------|-------|
| PouchDB Core | ~140 KB minified, ~46 KB gzipped | Includes sync/replication |
| pouchdb-find | ~30 KB minified | Query plugin |
| **Total** | **~170 KB minified** | Larger than Dexie for less functionality |

#### Performance Concerns

PouchDB has documented performance issues:
- **Revision tree overhead:** CouchDB's revision model (needed for sync/conflicts) adds storage and processing overhead even in local-only mode
- **Compaction needed:** Without periodic compaction, document revisions accumulate and degrade performance
- **Large document counts:** PouchDB performance degrades noticeably with tens of thousands of documents -- relevant for datspace's `chat_messages` (up to 50K) and `column_statistics` (up to 100K) collections
- **allDocs performance:** Bulk reads can be slow compared to indexed queries

#### Assessment

PouchDB was designed for CouchDB sync -- a capability datspace does not need. The sync/conflict resolution machinery adds overhead without benefit:

1. **No native reactive queries:** The biggest gap. Building reactive queries on change feeds requires significant custom engineering.
2. **Overhead from sync features:** Revision tracking, conflict resolution, and compaction are unnecessary for a single-user local app.
3. **Scalability concerns:** Known issues with large document counts would affect column_statistics and chat_messages collections.
4. **Declining maintenance:** While still maintained, PouchDB's development pace has slowed significantly.

**Verdict:** PouchDB is not recommended. It lacks native reactive queries (the primary requirement), carries unnecessary sync overhead, and has performance concerns at datspace's scale.

---

### 4. better-sqlite3 + Custom Reactive Layer

**License:** MIT (free)
**npm:** `better-sqlite3` (~1.5M weekly downloads)
**GitHub:** 5,000+ stars

#### Overview

better-sqlite3 is a fast, synchronous SQLite binding for Node.js. It runs natively in the Main Process, aligning perfectly with Constitution Principle 12. However, it has no built-in reactive query system -- one must be engineered.

#### Reactive Query Capabilities

better-sqlite3 provides **no reactive queries**. Options for adding reactivity:

**Option A: Polling**
```typescript
// Simplest but least efficient
setInterval(() => {
  const results = db.prepare('SELECT * FROM dashboards WHERE userId = ?').all('local');
  notifySubscribers('dashboards', results);
}, 100); // 100ms polling interval
```
- Wastes CPU re-running queries that haven't changed
- 100ms latency minimum
- Scales poorly with number of active queries

**Option B: Write-triggered notifications**
```typescript
// Wrap all writes to detect changes
function insertDashboard(doc) {
  db.prepare('INSERT INTO dashboards ...').run(doc);
  // Notify subscribers watching 'dashboards' table
  reactiveSubs.notify('dashboards');
}
```
- Requires wrapping ALL write operations
- Must determine which queries are affected by each write
- Essentially reimplementing EventReduce or liveQuery change detection

**Option C: SQLite update_hook**
```typescript
// SQLite provides update hooks via C API
// better-sqlite3 exposes this (limited)
db.function('on_change', () => { /* notify */ });
// But: only fires for the connection that made the change
```
- Limited to same-connection changes
- No query-level granularity (only table-level)
- Does not tell you which queries are affected

**Option D: SQLite session extension**
- Track changesets at the row level
- More granular than update_hook
- Still requires custom query invalidation logic

#### Engineering Effort Estimate

Building a reliable reactive query layer on top of better-sqlite3 would require:

| Component | Estimated Effort | Complexity |
|-----------|-----------------|------------|
| Write interception layer | 2-3 days | Medium |
| Query subscription manager | 3-5 days | High |
| Change-to-query mapping (which writes affect which queries) | 5-10 days | Very High |
| React hooks integration | 2-3 days | Medium |
| IPC bridge (Main to Renderer) | 3-5 days | Medium |
| Testing and edge cases | 5-10 days | High |
| **Total** | **20-36 days** | **High** |

This is essentially rebuilding what Dexie's `liveQuery()` or RxDB's EventReduce provides out of the box.

#### Process Model Fit

The main advantage of better-sqlite3: it runs natively in the **Main Process**, perfectly aligning with Constitution Principle 12. SQLite provides:
- ACID transactions with WAL mode
- Crash recovery
- Synchronous API (no callback overhead)
- Proven reliability (billions of deployments)

#### Bundle Size

| Component | Size | Notes |
|-----------|------|-------|
| better-sqlite3 (native addon) | ~2 MB | C++ addon |
| Custom reactive layer (JS) | ~10-20 KB | Estimated |
| **Total** | **~2 MB** | Native addon dominates |

#### Assessment

better-sqlite3 is an excellent database engine, but the lack of reactive queries is a critical gap:

1. **Engineering cost:** 20-36 days to build a reliable reactive layer is significant -- and it would likely be less battle-tested than Dexie's liveQuery (used by millions of apps).
2. **Maintenance burden:** A custom reactive layer becomes a perpetual maintenance responsibility.
3. **Architecture alignment:** Perfect for Principle 12 (Main Process), but requires IPC bridge for Renderer.
4. **Performance:** SQLite reads/writes would be faster than IndexedDB, but the reactive layer overhead would likely negate this advantage.

**Verdict:** better-sqlite3 is a strong database engine but the custom reactive layer requirement makes it a poor choice for the state layer. If reactive queries were not needed, it would be the clear winner. Consider it as a future optimization if Dexie.js performance proves insufficient.

---

### 5. LokiJS

**License:** MIT (free)
**npm:** `lokijs` (~40K weekly downloads)
**GitHub:** 6,700+ stars

#### Overview

LokiJS is an in-memory document database with optional persistence adapters. It provides DynamicViews for reactive-like query behavior.

#### Reactive Query Capabilities

LokiJS DynamicViews maintain a live result set:

```typescript
const dashboardView = db.getCollection('dashboards')
  .addDynamicView('activeDashboards')
  .applyFind({ userId: 'local' })
  .applySimpleSort('name');

// DynamicView auto-updates when collection changes
dashboardView.on('rebuild', () => {
  const results = dashboardView.data();
});
```

- **DynamicViews:** Maintain materialized views that auto-update on collection changes
- **Event-based:** Collections emit events on insert/update/remove
- **In-memory speed:** All data is in memory, so queries are extremely fast
- **Not observable-based:** No RxJS/Observable integration; uses custom events

#### Electron Compatibility

- Runs in any JavaScript environment (Main Process, Renderer, Worker)
- Persistence adapters available:
  - `LokiFsAdapter` for Node.js filesystem (Main Process)
  - `LokiIndexedDBAdapter` for Renderer
  - `LokiLocalStorageAdapter` (limited to ~5MB)
- Persistence is **asynchronous and periodic** (autosave interval), not per-write

#### Data Durability Concerns

This is LokiJS's critical weakness:

1. **In-memory first:** All data lives in JavaScript memory. Persistence is a secondary concern.
2. **Autosave interval:** By default, LokiJS periodically serializes the entire database to disk (e.g., every 5 seconds). Between autosaves, data only exists in memory.
3. **Crash = data loss:** If the app crashes between autosaves, all writes since the last save are lost.
4. **Full serialization:** Each save writes the entire database, not incremental changes. With large collections (100K column_statistics), this could be slow and cause UI jank.
5. **No transactions:** No ACID guarantees. Operations are immediate in memory but persistence is eventual.

For datspace, losing chat messages or metadata catalog entries on crash is unacceptable.

#### Maintenance Status

- **Last major release:** LokiJS 1.x is the stable version
- **LokiJS 2.x (Sylvie):** A fork/rewrite exists but development stalled
- **GitHub activity:** Minimal commits in recent years
- **npm downloads:** Declining trend
- **Assessment:** Effectively in maintenance mode. No active feature development.

#### Bundle Size

| Component | Size | Notes |
|-----------|------|-------|
| lokijs | ~19 KB minified | Very lightweight |
| **Total** | **~19 KB** | Smallest of all candidates |

#### Assessment

LokiJS is lightweight and fast for in-memory operations, but:

1. **Data durability is unacceptable:** Periodic full-database serialization with potential data loss on crash violates basic durability expectations for a desktop app managing user data.
2. **Stale maintenance:** Effectively unmaintained. No confidence in long-term viability.
3. **Primitive reactivity:** DynamicViews work but lack the Observable-based integration modern React apps expect.
4. **Scaling concern:** Full-database serialization becomes slow with large collections.

**Verdict:** Not recommended due to durability concerns and maintenance status. The small bundle size does not compensate for the risks.

---

## Comparison Tables

### Feature Comparison

| Feature | Dexie.js | RxDB Community | PouchDB | better-sqlite3 | LokiJS |
|---------|----------|----------------|---------|-----------------|--------|
| **License** | MIT | Apache 2.0 | Apache 2.0 | MIT | MIT |
| **Reactive queries** | liveQuery() | RxQuery + EventReduce | Manual (change feeds) | None (build custom) | DynamicViews |
| **React hooks** | useLiveQuery | Via RxJS adapter | None built-in | None | None |
| **Storage backend** | IndexedDB | IndexedDB (via Dexie) | IndexedDB | SQLite (native) | In-memory + adapters |
| **Schema enforcement** | Index declaration | JSON Schema | None | SQL DDL | Optional |
| **Migrations** | Version-based upgrade() | Per-document strategies | Manual | SQL ALTER/migrate | Manual |
| **Process (Electron)** | Renderer (native) | Renderer (IndexedDB) | Renderer (IndexedDB) | Main (Node.js) | Any |
| **Main Process support** | Via fake-indexeddb | Via fake-indexeddb | Via LevelDB adapter | Native | Native |
| **ACID transactions** | IndexedDB transactions | Via IndexedDB | Via IndexedDB | SQLite ACID | None |
| **Crash recovery** | Chromium IndexedDB WAL | Via IndexedDB | Via IndexedDB | SQLite WAL | Data loss risk |
| **Cross-tab reactive** | Yes | Yes | No | N/A | No |
| **IPC bridge needed** | No (Renderer-native) | No (Renderer-native) | No (Renderer-native) | Yes (Main to Renderer) | Depends on process |

### Performance Comparison (Estimated, M1/M2 Mac)

| Operation | Dexie.js | RxDB Community | PouchDB | better-sqlite3 | LokiJS |
|-----------|----------|----------------|---------|-----------------|--------|
| Single read (indexed) | < 1ms | 1-2ms | 1-3ms | < 0.5ms | < 0.1ms |
| Range query (100 from 10K) | 2-5ms | 3-8ms | 5-15ms | 1-3ms | < 1ms |
| Single insert | 1-3ms | 2-5ms | 3-8ms | < 1ms | < 0.1ms |
| Bulk insert (1,000) | 50-200ms | 100-300ms | 200-500ms | 10-50ms | < 10ms |
| Reactive re-evaluation | 1-5ms | 0.5-2ms (EventReduce) | N/A | N/A | 1-3ms |

### Bundle Size Comparison

| Candidate | JS Bundle (minified) | Native Addon | Total |
|-----------|---------------------|--------------|-------|
| **Dexie.js** | **~83 KB** | None | **~83 KB** |
| RxDB Community | ~183 KB | None | ~183 KB |
| PouchDB | ~170 KB | None | ~170 KB |
| better-sqlite3 | ~10 KB (custom layer) | ~2 MB | ~2 MB |
| LokiJS | ~19 KB | None | ~19 KB |

### Community Health Comparison

| Metric | Dexie.js | RxDB | PouchDB | better-sqlite3 | LokiJS |
|--------|----------|------|---------|-----------------|--------|
| **npm weekly downloads** | ~3.5M | ~30K | ~200K | ~1.5M | ~40K |
| **GitHub stars** | 11K+ | 21K+ | 16K+ | 5K+ | 6.7K+ |
| **Last release** | Recent | Recent | Infrequent | Recent | Stale |
| **Active maintenance** | Yes | Yes | Slow | Yes | No |
| **Documentation quality** | Excellent | Good | Good | Good | Adequate |

---

## Constitution Principle Analysis

### Principle 10: Embedded-Only Databases

All five candidates satisfy this principle. None require external database servers.

### Principle 12: Process Isolation (Main Process Owns Databases)

This is the most nuanced principle for the reactive state layer:

**Strict interpretation:** Only better-sqlite3 fully satisfies this -- it runs natively in Node.js (Main Process) with SQLite.

**Pragmatic interpretation:** Principle 12 was designed to ensure that heavyweight database engines (DuckDB, LanceDB) with native addons and complex resource management run in the Main Process for crash isolation and resource control. The reactive state layer is fundamentally different:

1. It manages UI state that is consumed by the Renderer
2. It uses a browser-native API (IndexedDB) that is designed for the Renderer
3. The data volumes are small (application state, not analytical data)
4. Crash isolation is less critical (app state can be rebuilt from DuckDB/LanceDB)
5. Running in Renderer eliminates IPC bridging for reactive queries, which is the primary use case

**Recommendation:** Accept Renderer-side placement for the reactive state layer as a pragmatic deviation. Document this as an architectural decision with rationale. The spirit of Principle 12 (isolating heavyweight engines from the UI) is preserved.

### Principle 14: Single-User, Local-First

All candidates work in local-only mode. PouchDB and RxDB have sync features that can be disabled. Dexie.js is local-only by default (Dexie Cloud is a separate optional addon).

---

## Alternatives Considered

### Dexie.js vs RxDB Community Edition

| Criterion | Dexie.js | RxDB Community |
|-----------|----------|----------------|
| **Reactive queries** | liveQuery() -- native, efficient | RxQuery + EventReduce -- more sophisticated |
| **React integration** | useLiveQuery (direct) | Via RxJS subscription adapters |
| **Bundle size** | ~83 KB | ~183 KB (2.2x) |
| **Storage** | IndexedDB directly | IndexedDB via Dexie.js wrapper |
| **Complexity** | Simple API | Larger API surface, JSON Schema required |
| **Community** | 3.5M weekly downloads | 30K weekly downloads |
| **Learning curve** | Low | Medium |

**Verdict:** Dexie.js is preferred. RxDB Community wraps Dexie.js and adds reactive queries, but Dexie now has native `liveQuery()`. The additional abstraction layer adds bundle size and complexity without proportional benefit.

### Dexie.js vs PouchDB

| Criterion | Dexie.js | PouchDB |
|-----------|----------|---------|
| **Reactive queries** | liveQuery() (built-in) | Manual (change feeds only) |
| **Unnecessary features** | None | Sync, conflict resolution, revision tracking |
| **Performance at scale** | Good (IndexedDB) | Degrades with large document counts |
| **Bundle size** | ~83 KB | ~170 KB |
| **Maintenance** | Active | Slowing |

**Verdict:** Dexie.js is clearly preferred. PouchDB's sync-oriented design adds overhead without benefit for a single-user local app.

### Dexie.js vs better-sqlite3 + Custom Reactive Layer

| Criterion | Dexie.js | better-sqlite3 + Custom |
|-----------|----------|------------------------|
| **Reactive queries** | Built-in (liveQuery) | Must build (20-36 days) |
| **Process model** | Renderer (IndexedDB) | Main (Node.js) |
| **Raw performance** | Good | Better (SQLite is faster) |
| **Development cost** | Zero -- ready to use | Significant engineering |
| **Maintenance** | Community-maintained | Self-maintained |
| **Risk** | Low (proven library) | Medium (custom code) |

**Verdict:** Dexie.js is preferred unless raw SQLite performance is required. The engineering cost of a custom reactive layer is not justified when Dexie.js provides it out of the box. If performance issues arise later, better-sqlite3 can be adopted as an optimization.

### Dexie.js vs LokiJS

| Criterion | Dexie.js | LokiJS |
|-----------|----------|--------|
| **Data durability** | IndexedDB (disk-backed) | In-memory (periodic serialization) |
| **Crash safety** | Survives crash | Data loss on crash |
| **Maintenance** | Active | Effectively abandoned |
| **Bundle size** | ~83 KB | ~19 KB |
| **Performance** | Good | Faster (in-memory) |

**Verdict:** Dexie.js is preferred. LokiJS's data durability issues and abandoned maintenance status are disqualifying despite its smaller bundle size.

### Dexie.js vs electron-store

| Criterion | Dexie.js | electron-store |
|-----------|----------|----------------|
| **Data model** | Indexed document collections | Single JSON file (key-value) |
| **Querying** | Complex queries with indexes | Key-value lookup only |
| **Reactive** | liveQuery() | File-watch (crude) |
| **Scale** | Millions of documents | < 10 MB practical limit |

**Verdict:** electron-store is insufficient. datspace needs queryable, indexed, reactive collections -- electron-store can only handle simple settings.

---

## Recommendation

### Primary Recommendation: Dexie.js

**Use Dexie.js as the reactive state layer for datspace, running in the Renderer process with native IndexedDB.**

### Rationale

1. **Reactive queries are built-in and proven.** `liveQuery()` provides push-based live queries that automatically re-evaluate when underlying data changes. The `useLiveQuery` React hook integrates directly with React's rendering cycle. This is the primary requirement and Dexie delivers it with zero custom engineering.

2. **Zero cost, MIT license.** Completely free with no paid tiers needed. No licensing risk, no budget dependency.

3. **Minimal bundle impact.** At ~83 KB minified (~27 KB gzipped), Dexie.js adds negligible weight to the Electron application. No native addons, no WASM, no compilation step.

4. **Excellent developer experience.** Dexie's API is clean and intuitive -- dramatically better than raw IndexedDB. Promises, compound indexes, bulk operations, and migration support are all built in.

5. **Massive community.** With ~3.5 million weekly npm downloads and 11K+ GitHub stars, Dexie.js is one of the most widely-used IndexedDB libraries. Issues are well-documented, edge cases are known, and the maintainer is responsive.

6. **Adequate performance for the use case.** datspace's reactive state layer manages UI state, metadata, and chat history -- not analytical data. The largest collection (column_statistics) may reach 100K documents, which IndexedDB handles well in Chromium's implementation.

7. **IndexedDB is native to Electron.** No additional runtime, no native addon compilation, no WASM. IndexedDB is built into Chromium, which Electron includes. It is the most natural storage API for Electron's Renderer process.

8. **Schema migrations are straightforward.** Dexie's version-based `upgrade()` system handles schema evolution cleanly as datspace progresses through its roadmap phases.

### Architecture: Renderer-Side Placement

```
Renderer Process (Chromium)
  |
  +-- Dexie.js instance
  |     - IndexedDB storage (Chromium native)
  |     - liveQuery() reactive subscriptions
  |     - useLiveQuery React hooks
  |     - All collections: preferences, dashboards, metadata, chat, etc.
  |
  +-- React UI
        - Components subscribe via useLiveQuery
        - Automatic re-render on data changes

Main Process (Node.js)
  |
  +-- DuckDB Worker Thread (analytical queries)
  +-- LanceDB (vector search)
  |
  +-- IPC Bridge to Renderer (for cross-process operations)
        - Main Process can request Renderer to write to Dexie
        - e.g., after metadata scan, Main sends results to Renderer
        - Renderer writes to Dexie, liveQuery updates UI automatically
```

**Why Renderer-side:** The reactive state layer is fundamentally UI state. Placing it in the Renderer eliminates IPC bridging for the most common operation (UI reads + reactive updates). Main Process operations that need to update state (e.g., background metadata scans) can push data to Renderer via standard Electron IPC, where it is written to Dexie and triggers reactive updates.

### Architectural Decision: Principle 12 Deviation

Constitution Principle 12 states "Main Process owns database engines." For the reactive state layer, the architecture places Dexie.js in the Renderer process. This is a documented deviation with the following rationale:

- Principle 12 targets heavyweight engines (DuckDB, LanceDB) that need crash isolation and resource management
- The reactive state layer manages small documents (UI state, metadata) not analytical data
- IndexedDB is a browser-native API designed for the Renderer process
- Running in Renderer eliminates IPC bridging for reactive queries (the primary use case)
- App state can be rebuilt from DuckDB/LanceDB metadata if the Renderer crashes
- DuckDB and LanceDB remain in the Main Process per Principle 12

### Configuration Recommendations

| Setting | Value | Reason |
|---------|-------|--------|
| Database name | `'Datspace'` | Single Dexie database for all app state |
| Storage | Native IndexedDB (Chromium) | No polyfills needed in Renderer |
| Location | Electron's profile directory (automatic) | Persists across app updates |
| React hooks | `dexie-react-hooks` | Direct integration with React components |
| Sync | Disabled (no Dexie Cloud) | Single-user, local-only |

### Collection Schema Design

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

Note: Only indexed properties are declared. All other properties are stored automatically without declaration.

### Risk Mitigation

| Risk | Mitigation |
|------|------------|
| IndexedDB size limits in Chromium | Electron apps get generous storage (no 10% quota). Monitor with `navigator.storage.estimate()`. |
| IndexedDB reliability in Electron | Chromium's IndexedDB is mature and well-tested. Electron releases test against it. |
| Performance with 100K documents | Use compound indexes for column_statistics. Paginate queries. Profile early. |
| Main Process needs to read state | IPC bridge: Main requests data from Renderer's Dexie instance. For background tasks, Main can use fake-indexeddb as a staging area. |
| Renderer crash loses in-flight writes | IndexedDB transactions are atomic. Committed data survives. Uncommitted writes (in-flight) are lost, which is acceptable for UI state. |
| Dexie.js maintenance risk | 3.5M weekly downloads and 11K stars indicate strong community. MIT license allows forking if needed. |

### Implementation Priority

In the datspace roadmap:

1. **Phase 1 (Foundation):** Initialize Dexie.js with `user_preferences` and `data_sources` collections. Set up `useLiveQuery` patterns in React.
2. **Phase 2 (Data Ingestion):** Add `table_metadata` and `column_statistics` collections. Main Process pushes scan results to Renderer via IPC for Dexie storage.
3. **Phase 3 (Visualization):** Add `dashboards` collection with layout and filter state.
4. **Phase 4 (AI Chat):** Add `chat_conversations` and `chat_messages` collections.
5. **Phase 5+:** Evolve schemas with Dexie's `version().upgrade()` as features expand.

### Future Optimization Path

If Dexie.js/IndexedDB performance proves insufficient for specific use cases:

1. **Targeted SQLite migration:** Move high-write collections (chat_messages, column_statistics) to better-sqlite3 in the Main Process with a custom IPC bridge, while keeping low-write reactive collections in Dexie.js.
2. **Dexie 4.x:** The upcoming Dexie 4.x release promises further performance improvements and reactive query enhancements.
3. **RxDB adoption:** If reactive query complexity grows, RxDB Community can be layered on top of Dexie.js for its EventReduce algorithm without changing the storage backend.

---

## References

- Dexie.js Documentation: https://dexie.org/
- Dexie liveQuery: https://dexie.org/docs/liveQuery()
- Dexie React Hooks: https://dexie.org/docs/dexie-react-hooks/useLiveQuery()
- fake-indexeddb: https://github.com/nicolo-ribaudo/fake-indexeddb
- RxDB Documentation: https://rxdb.info/
- RxDB Community vs Premium: https://rxdb.info/premium/
- PouchDB: https://pouchdb.com/
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- LokiJS: https://github.com/techfort/LokiJS
- IndexedDB in Chromium: https://chromium.googlesource.com/chromium/src/+/main/content/browser/indexed_db/
- Electron IPC: https://www.electronjs.org/docs/latest/tutorial/ipc
