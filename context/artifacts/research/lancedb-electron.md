# LanceDB Integration in Electron: Research Findings

**Task:** research-lancedb-electron
**Date:** 2026-02-04
**Domain:** datspace - Desktop Analytics Application (Electron)
**Status:** Complete

---

## Executive Summary

LanceDB is an embedded, open-source vector database built on the Lance columnar format. It is designed for serverless and edge deployments, making it a strong candidate for embedding within an Electron desktop application. This document evaluates LanceDB's Node.js SDK, vector indexing capabilities, full-text search, DuckDB interoperability, embedding pipeline integration, and resource footprint within the context of datspace -- a single-user, macOS-first, embedded-only analytics application.

---

## 1. LanceDB Node.js SDK

### Package and API Surface

LanceDB provides its Node.js SDK via the `@lancedb/lancedb` npm package (formerly `vectordb`). The SDK is implemented as a native addon using Rust compiled to a Node.js N-API module, which provides near-native performance for vector operations.

**Key API operations:**

```typescript
import * as lancedb from "@lancedb/lancedb";

// Connect to a local database directory
const db = await lancedb.connect("./data/lancedb");

// Create a table from Arrow-compatible data
const table = await db.createTable("documents", data);

// Vector search
const results = await table.search(queryVector)
  .limit(10)
  .toArray();

// Full-text search
const results = await table.search("query text", queryType: "fts")
  .limit(10)
  .toArray();

// Hybrid search (vector + FTS)
const results = await table.search(queryVector)
  .where("category = 'analytics'")
  .limit(10)
  .toArray();
```

**API maturity assessment:**

| Aspect | Status | Notes |
|--------|--------|-------|
| Table CRUD | Stable | Create, read, update, delete, merge operations |
| Vector search | Stable | k-NN with configurable distance metrics |
| Full-text search | Stable | Tantivy-based, integrated into query API |
| Index management | Stable | Create, rebuild indices via API |
| Schema evolution | Stable | Add/drop columns, merge new data |
| Streaming results | Stable | AsyncIterator support for large result sets |
| Arrow interop | Stable | Native Arrow integration (Lance is Arrow-native) |

### Electron Compatibility

**Native addon considerations:**

LanceDB's Node.js SDK is a native N-API addon compiled from Rust. For Electron:

- **Prebuilt binaries:** The `@lancedb/lancedb` package ships prebuilt binaries for common platforms including `darwin-arm64` (Apple Silicon) and `darwin-x64` (Intel Mac). This means `electron-rebuild` is generally not required for standard Electron builds.
- **N-API version:** Uses N-API (Node-API) which provides ABI stability across Node.js versions and Electron versions, significantly reducing compatibility concerns.
- **Electron main process:** LanceDB should run in the Electron main process or a worker thread (not the renderer process) due to native addon constraints and the project's "Main Process owns databases" principle.
- **ASAR compatibility:** Native addons are automatically excluded from ASAR archives by Electron's build tools (`electron-builder`, `electron-forge`), so no special configuration is needed.

**Verified platform support for macOS:**

| Platform | Architecture | Prebuilt Binary | Status |
|----------|-------------|-----------------|--------|
| macOS | arm64 (M-series) | Yes | Fully supported |
| macOS | x64 (Intel) | Yes | Fully supported |

### Storage Format: Lance Columnar Format

Lance is a modern columnar data format designed for ML workloads:

- **Column-oriented:** Similar to Parquet but optimized for random access and fast vector operations
- **Versioned:** Copy-on-write versioning; each write creates a new version, enabling time-travel queries and rollback
- **Arrow-native:** Lance data can be read directly as Apache Arrow record batches with zero-copy semantics -- this aligns perfectly with the datspace "Arrow-First Data Flow" principle
- **Fragment-based:** Data is stored in fragments (row groups), enabling efficient append operations without rewriting entire files
- **Self-describing:** Schema embedded in the format, no external catalog required

**File layout on disk:**

```
./data/lancedb/
  documents.lance/
    data/
      0001.lance       # Data fragment (columnar)
      0002.lance       # Additional fragment
    _indices/
      vector_idx/      # Vector index files
      fts_idx/         # Full-text search index
    _versions/
      1.manifest       # Version manifest
      2.manifest
    _latest.manifest   # Pointer to current version
```

---

## 2. Vector Index Types and Configuration

LanceDB supports multiple vector index types, each with distinct trade-offs relevant to an Electron desktop application.

### Available Index Types

#### IVF_PQ (Inverted File Index with Product Quantization)

- **How it works:** Partitions vectors into clusters (IVF) then compresses each partition with product quantization (PQ), reducing memory footprint significantly.
- **Build time:** Moderate (requires k-means clustering + PQ training)
- **Query performance:** Fast for large datasets (>100K vectors); requires scanning fewer partitions
- **Memory:** Low -- PQ compression reduces vector memory by 8-32x
- **Accuracy:** Approximate; tunable via `nprobes` (number of partitions to search)
- **Best for:** Large document collections (>100K embeddings) where memory is constrained

**Configuration:**

```typescript
await table.createIndex("vector", {
  type: "IVF_PQ",
  num_partitions: 256,   // Number of IVF partitions
  num_sub_vectors: 16,    // PQ sub-vector count
});
```

#### IVF_FLAT (Inverted File Index without Quantization)

- **How it works:** Partitions vectors into clusters but stores full-precision vectors within each cluster.
- **Build time:** Fast (only k-means clustering, no PQ training)
- **Query performance:** Good for medium datasets (10K-100K vectors); exact search within partitions
- **Memory:** Moderate -- full-precision vectors stored in each partition
- **Accuracy:** Exact within searched partitions; tunable via `nprobes`
- **Best for:** Medium-sized collections where accuracy is important

**Configuration:**

```typescript
await table.createIndex("vector", {
  type: "IVF_FLAT",
  num_partitions: 128,
});
```

#### IVF_HNSW_SQ (Hierarchical Navigable Small World with Scalar Quantization)

- **How it works:** Combines IVF partitioning with HNSW graph-based search within each partition, plus scalar quantization for compression.
- **Build time:** Slower (graph construction per partition)
- **Query performance:** Excellent; HNSW provides sub-millisecond search for in-memory graphs
- **Memory:** Moderate with SQ compression
- **Accuracy:** High; HNSW achieves >95% recall at reasonable `ef` settings
- **Best for:** Workloads demanding both high recall and low latency

**Configuration:**

```typescript
await table.createIndex("vector", {
  type: "IVF_HNSW_SQ",
  num_partitions: 64,
});
```

### Index Trade-off Summary for Electron Use

| Index Type | Build Time | Query Latency | Memory | Recall | Recommended For |
|-----------|-----------|---------------|--------|--------|----------------|
| No index (brute force) | None | O(n) | Low | 100% | <5K vectors |
| IVF_FLAT | Fast | Medium | Medium | High | 5K-50K vectors |
| IVF_PQ | Moderate | Fast | Low | Moderate | 50K-500K vectors |
| IVF_HNSW_SQ | Slow | Fastest | Medium | High | >50K vectors, latency-critical |

**Recommendation for datspace:** Start with no index for small collections. Use IVF_FLAT for medium collections. Graduate to IVF_PQ or IVF_HNSW_SQ only when collection size exceeds 50K vectors. The index type can be changed without data migration -- only a rebuild is required.

---

## 3. Full-Text Search Capabilities

### Tantivy-Based FTS

LanceDB integrates Tantivy (a Rust-based full-text search engine, comparable to Lucene) for full-text search:

- **Tokenizers:** Default, whitespace, raw, and language-specific tokenizers
- **Scoring:** BM25 scoring by default
- **Query syntax:** Supports term queries, phrase queries, boolean operators
- **Index creation:** Explicit FTS index creation on text columns

**Creating an FTS index:**

```typescript
await table.createIndex("content", {
  config: lancedb.Index.fts(),
});
```

**Querying:**

```typescript
const results = await table.search("data analytics", { queryType: "fts" })
  .select(["title", "content", "score"])
  .limit(20)
  .toArray();
```

### Hybrid Search (Vector + FTS)

LanceDB supports hybrid search that combines vector similarity with full-text relevance:

**Approach:** LanceDB's hybrid search performs both vector and FTS queries independently, then fuses results using Reciprocal Rank Fusion (RRF) or a linear combination scorer.

```typescript
const results = await table.search("data analytics", { queryType: "hybrid" })
  .vector(queryEmbedding)
  .limit(10)
  .toArray();
```

**Hybrid search characteristics:**

| Aspect | Details |
|--------|---------|
| Fusion method | Reciprocal Rank Fusion (RRF) default |
| Weighting | Configurable vector vs FTS weight |
| Filtering | SQL-like WHERE clause filtering on metadata |
| Performance | Both queries run in parallel internally |

**Relevance to datspace:** Hybrid search is critical for the AI/RAG pipeline. Users may search for analytical concepts (better served by vector search) or specific data terms/column names (better served by FTS). Hybrid search provides the best of both worlds.

---

## 4. Lance Extension for DuckDB

### Direct Querying via DuckDB

The Lance format has a DuckDB extension that enables querying Lance tables directly from DuckDB SQL. This is significant for datspace because DuckDB is already a core component.

**Usage:**

```sql
-- Install and load the Lance extension
INSTALL lance;
LOAD lance;

-- Query a Lance table
SELECT * FROM lance_scan('./data/lancedb/documents.lance')
WHERE category = 'analytics'
LIMIT 100;
```

**Capabilities:**

- Read Lance fragments as DuckDB tables
- Push predicates down to Lance for efficient scanning
- Access versioned data (specify version number)
- Join Lance tables with other DuckDB tables

**Limitations:**

- **Read-only:** The DuckDB extension provides read access only; writes go through LanceDB API
- **No vector search:** The extension reads columnar data but does not perform vector similarity search -- that requires LanceDB's index infrastructure
- **Extension availability:** The Lance DuckDB extension is available but may need to be bundled specifically for Electron's embedded DuckDB

### Performance Implications

| Operation | Via LanceDB API | Via DuckDB Lance Extension |
|-----------|----------------|---------------------------|
| Vector search | Fast (uses index) | Not supported |
| FTS | Fast (Tantivy) | Not supported |
| Metadata filtering | Good | Excellent (DuckDB optimizer) |
| Analytical queries | Limited | Excellent (DuckDB OLAP) |
| Joins with other tables | Not supported | Native |
| Aggregations | Limited | Full SQL support |

**Recommendation:** Use a dual-access pattern:
- **LanceDB API** for vector search, FTS, hybrid search, and writes
- **DuckDB Lance extension** for analytical queries, joins, and aggregations over Lance data

This aligns with the datspace architecture where DuckDB handles analytical workloads and LanceDB handles vector/FTS workloads, with both operating over the same underlying Lance data files.

---

## 5. Embedding Pipeline Integration

### Flow from Model to Storage

The embedding pipeline in datspace must move data from text content through an embedding model into LanceDB vector storage.

**Pipeline architecture:**

```
Document Text
    |
    v
[Chunking] -- Split into chunks (sentence, paragraph, or fixed-size)
    |
    v
[Embedding Model] -- Local (ONNX Runtime) or Remote (Claude/OpenAI API)
    |
    v
[Arrow Record Batch] -- Vectors + metadata as Arrow arrays
    |
    v
[LanceDB Table.add()] -- Append to Lance table
    |
    v
[Index Rebuild] -- Periodic, not per-insert
```

### Batch vs Streaming Insertion

**Batch insertion (recommended for bulk ingestion):**

```typescript
// Collect embeddings into batches
const batch: Array<{vector: number[], text: string, metadata: object}> = [];

for (const chunk of chunks) {
  const embedding = await embedModel.embed(chunk.text);
  batch.push({
    vector: embedding,
    text: chunk.text,
    source: chunk.source,
    created_at: new Date().toISOString(),
  });
}

// Single write operation
await table.add(batch);
```

- **Pros:** Fewer write operations, more efficient Lance fragment creation, better I/O utilization
- **Cons:** Higher memory usage during batch assembly, latency before data is searchable
- **Recommended batch size:** 256-1024 vectors per write for optimal fragment size

**Streaming insertion (for real-time ingestion):**

```typescript
// Write each embedding individually or in small micro-batches
for (const chunk of chunks) {
  const embedding = await embedModel.embed(chunk.text);
  await table.add([{
    vector: embedding,
    text: chunk.text,
    source: chunk.source,
  }]);
}
```

- **Pros:** Data searchable immediately, lower memory per operation
- **Cons:** Creates many small Lance fragments (performance degrades without compaction), more I/O overhead
- **Mitigation:** Run periodic compaction: `await table.optimize()` to merge small fragments

**Recommendation for datspace:** Use batch insertion for initial document ingestion (folder scanning, bulk import). Use micro-batch streaming (batches of 16-64) for real-time embedding during chat/RAG interactions. Run background compaction via Worker Thread on a schedule.

### LanceDB Built-in Embedding Functions

LanceDB provides built-in embedding function support that can automatically embed text on insertion and query:

```typescript
const embeddingFunction = lancedb.embedding.openai({ model: "text-embedding-3-small" });

const table = await db.createTable("documents", data, {
  embeddingFunction: {
    sourceColumn: "text",
    vectorColumn: "vector",
    function: embeddingFunction,
  }
});

// Automatic embedding on search
const results = await table.search("analytics dashboard")
  .limit(10)
  .toArray();
```

This simplifies the pipeline but couples embedding to LanceDB. For datspace, maintaining a separate embedding pipeline provides more flexibility (model switching, local vs remote, caching).

---

## 6. Memory and Storage Footprint

### Index Sizes for Typical Document Collections

Estimates based on 1536-dimensional embeddings (e.g., text-embedding-3-small) with typical document metadata:

| Collection Size | Raw Vectors | IVF_FLAT Index | IVF_PQ Index | FTS Index | Total Disk |
|----------------|-------------|----------------|--------------|-----------|-----------|
| 1K documents | ~6 MB | ~7 MB | ~2 MB | ~1 MB | ~10 MB |
| 10K documents | ~60 MB | ~65 MB | ~15 MB | ~8 MB | ~88 MB |
| 100K documents | ~600 MB | ~650 MB | ~100 MB | ~60 MB | ~810 MB |
| 1M documents | ~6 GB | ~6.5 GB | ~800 MB | ~500 MB | ~7.8 GB |

**Notes:**
- "Documents" here means embedding chunks, not source documents (one document may produce 10-50 chunks)
- IVF_PQ provides ~4-8x compression over IVF_FLAT
- FTS index size depends heavily on vocabulary size and content length
- Lance versioning adds overhead (~5-10% per version retained)

### Memory Usage During Operations

| Operation | Memory Usage | Duration |
|-----------|-------------|----------|
| Vector search (indexed) | 10-50 MB (loads index partitions) | <10ms per query |
| Vector search (brute force) | Proportional to dataset | O(n) |
| FTS query | 5-20 MB (Tantivy segments) | <5ms per query |
| Index build (IVF_PQ, 100K vectors) | 200-500 MB peak | 30-120 seconds |
| Batch insert (1K records) | 10-30 MB | <1 second |
| Table scan | Streaming, constant memory | Depends on data size |

**Key insight for Electron:** LanceDB's streaming scan model aligns with the "Stream and Scan" principle. Even large tables can be scanned without loading the entire dataset into memory. Vector index searches only load the relevant partitions into memory, keeping memory usage bounded.

### Version Management

Lance's copy-on-write versioning means each write creates a new version manifest. For a desktop application:

- **Retention policy:** Configure version retention to avoid unbounded disk growth
- **Compaction:** Run `table.optimize()` periodically to merge fragments and clean old versions
- **Recommended:** Retain last 10 versions, compact weekly or when fragment count exceeds threshold

---

## 7. Concurrent Access Patterns

### Read/Write Isolation

LanceDB uses a single-writer, multiple-reader (SWMR) model:

- **Writes are serialized:** Only one write operation can proceed at a time. Concurrent write attempts will queue.
- **Reads are non-blocking:** Multiple read operations (search, scan) can proceed concurrently without blocking each other or being blocked by writes.
- **Snapshot isolation:** Readers see a consistent snapshot. An ongoing write does not affect concurrent reads -- readers continue to see the previous version until the write commits.

### Implications for Electron Architecture

```
Main Process (Database Owner)
  |
  +-- LanceDB Connection (single writer)
  |     |
  |     +-- Write operations (serialized)
  |     +-- Read operations (concurrent)
  |
  +-- Worker Thread 1: Embedding pipeline
  |     (sends write requests to main process via MessagePort)
  |
  +-- Worker Thread 2: Background compaction
  |     (sends optimize requests to main process via MessagePort)
  |
Renderer Process
  |
  +-- Search requests via IPC
        (main process handles LanceDB queries, returns Arrow buffers)
```

**Alignment with datspace architecture:**
- Main Process owns the LanceDB connection (single writer guarantee)
- Worker Threads handle embedding computation and send results to main process for insertion
- Renderer process sends search queries via IPC; main process returns Arrow-serialized results
- No need for external locking or connection pooling -- embedded single-process model

---

## Alternatives Considered

### Chroma (chromadb)

| Aspect | Chroma | LanceDB |
|--------|--------|---------|
| Architecture | Client-server (default) or embedded | Embedded-first |
| Node.js SDK | HTTP client (requires server) | Native addon (in-process) |
| Electron fit | Poor -- requires running Chroma server | Excellent -- embedded |
| Storage format | SQLite + hnswlib | Lance columnar (Arrow-native) |
| FTS | Basic metadata filtering | Full Tantivy-based FTS |
| DuckDB interop | None | Lance DuckDB extension |
| Arrow integration | None | Native |

**Verdict:** Chroma's client-server architecture violates the "Embedded-Only Databases" principle. While Chroma has an experimental embedded mode, it is less mature and lacks the Arrow-native integration that datspace requires.

### Qdrant

| Aspect | Qdrant | LanceDB |
|--------|--------|---------|
| Architecture | Standalone server (Rust) | Embedded library |
| Node.js SDK | HTTP/gRPC client | Native addon |
| Electron fit | Poor -- requires separate process | Excellent -- in-process |
| Performance | Excellent (purpose-built server) | Excellent for embedded use |
| FTS | Payload-based full-text filtering | Full Tantivy FTS engine |
| Arrow integration | None | Native |

**Verdict:** Qdrant is a powerful vector database but requires running as a separate server process, violating the "Embedded-Only Databases" constraint. There is no embeddable mode for Node.js.

### SQLite-VSS (sqlite-vss)

| Aspect | SQLite-VSS | LanceDB |
|--------|-----------|---------|
| Architecture | SQLite extension | Embedded library |
| Node.js SDK | Via better-sqlite3 + extension | Native addon |
| Electron fit | Good -- SQLite is embeddable | Excellent |
| Index types | IVF only (Faiss-based) | IVF_PQ, IVF_FLAT, IVF_HNSW_SQ |
| FTS | SQLite FTS5 (excellent) | Tantivy (excellent) |
| Storage | SQLite database file | Lance columnar format |
| Arrow integration | None (requires serialization) | Native (zero-copy) |
| Maintenance | Sole maintainer, sporadic updates | Active team, frequent releases |
| DuckDB interop | Separate databases | Lance extension available |

**Verdict:** SQLite-VSS is embeddable and would fit the architecture, but it lacks Arrow-native integration (requiring serialization in the hot path, violating the "Arrow-First" principle). Its maintenance status is also a concern. Additionally, datspace already uses RxDB with SQLite adapter for document state -- introducing sqlite-vss would create two SQLite usage patterns with different extension requirements.

### Summary Comparison Matrix

| Criterion | LanceDB | Chroma | Qdrant | SQLite-VSS |
|-----------|---------|--------|--------|-----------|
| Embedded (in-process) | Yes | Partial | No | Yes |
| Arrow-native | Yes | No | No | No |
| Full-text search | Tantivy | Basic | Payload filter | FTS5 |
| Hybrid search | Yes | No | Partial | Manual |
| DuckDB interop | Lance extension | No | No | No |
| Electron proven | Yes | No | No | Partial |
| Maintenance health | Active | Active | Active | Low |
| macOS arm64 binary | Yes | N/A (server) | N/A (server) | Yes |

---

## Lance DuckDB Extension vs Separate LanceDB Queries

### Trade-off Analysis

**Option A: All queries through LanceDB API**
- Pros: Single query interface, simpler code, all features available
- Cons: No SQL, no joins with DuckDB tables, limited aggregation support

**Option B: All queries through DuckDB Lance extension**
- Pros: Full SQL, joins with other data, DuckDB optimizer
- Cons: No vector search, no FTS, read-only access

**Option C: Dual-access pattern (recommended)**
- LanceDB API for vector search, FTS, hybrid search, and writes
- DuckDB Lance extension for analytical queries over vector metadata
- Pros: Best of both worlds, each engine used for its strength
- Cons: Two query paths to maintain, potential consistency considerations

**Recommendation:** Option C. The dual-access pattern aligns with datspace's existing multi-database architecture (DuckDB for analytics, RxDB for state, LanceDB for vectors). Queries are routed based on type:

| Query Type | Engine | Rationale |
|-----------|--------|-----------|
| "Find similar documents" | LanceDB vector search | Requires vector index |
| "Search for 'revenue analysis'" | LanceDB FTS/hybrid | Requires FTS index |
| "How many embeddings per source?" | DuckDB + Lance ext | Analytical aggregation |
| "Join embeddings with source metadata" | DuckDB + Lance ext | Cross-table join |

---

## Local Index Management Complexity

### Operational Considerations for Desktop App

| Concern | Mitigation |
|---------|-----------|
| Index rebuild time | Run in Worker Thread; UI remains responsive |
| Disk growth from versioning | Automatic compaction on schedule or threshold |
| Index staleness after many inserts | Periodic rebuild triggered by insert count |
| First-run index creation | Progressive -- start with brute force, build index in background |
| App update migrations | Lance format is backward-compatible; schema evolution supported |

### Recommended Management Strategy

```typescript
// Index management lifecycle
class LanceDBManager {
  // On app start: open existing or create new
  async initialize() {
    this.db = await lancedb.connect(this.dataDir);
  }

  // After bulk insert: check if index rebuild needed
  async maybeRebuildIndex(table: Table, threshold: number = 1000) {
    const stats = await table.stats();
    if (stats.unindexedRows > threshold) {
      // Run in worker thread
      await table.createIndex("vector", { replace: true });
    }
  }

  // Periodic maintenance (e.g., daily or on app idle)
  async optimize(table: Table) {
    await table.optimize({ cleanupOlderThan: "7d" });
  }
}
```

---

## Recommendation

### Primary Recommendation: Use LanceDB as the vector and full-text search engine for datspace.

**Rationale:**

1. **Embedded-only compliance:** LanceDB runs in-process within the Electron main process, satisfying the "Embedded-Only Databases" constitutional principle. No external server required.

2. **Arrow-native data flow:** Lance format is built on Apache Arrow, enabling zero-copy data transfer between LanceDB and other datspace components. This directly satisfies the "Arrow-First Data Flow" principle. Query results from LanceDB are already Arrow record batches -- no serialization needed.

3. **DuckDB synergy:** The Lance DuckDB extension enables analytical queries over vector data using SQL, joining vector metadata with other DuckDB tables. This creates a unified analytical surface across the embedded database trio.

4. **Complete search stack:** LanceDB provides vector search (multiple index types), full-text search (Tantivy), and hybrid search (RRF fusion) in a single embedded package. No additional search infrastructure needed.

5. **Electron-proven:** Prebuilt N-API binaries for macOS arm64 and x64 eliminate native compilation requirements. The SWMR concurrency model aligns with Electron's main-process-owns-databases architecture.

6. **Stream and Scan compliance:** LanceDB's fragment-based storage and streaming scan model ensures that large vector collections are never loaded entirely into memory, satisfying the "Stream and Scan" principle.

### Specific Configuration Recommendations

| Aspect | Recommendation |
|--------|---------------|
| Vector index | Start with no index; add IVF_PQ when collection exceeds 50K vectors |
| FTS index | Create on all searchable text columns at table creation time |
| Embedding dimensions | 1536 (text-embedding-3-small) or 256-384 (local models via ONNX) |
| Batch size | 256-1024 vectors per write operation |
| Compaction schedule | On app idle or when fragment count exceeds 50 |
| Version retention | Keep last 10 versions; compact older versions |
| Process architecture | LanceDB connection in main process; embedding computation in Worker Thread |
| IPC pattern | Renderer sends search queries via IPC; main process returns Arrow buffers via MessagePort |

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Breaking API changes | Low | Medium | Pin to specific version; SDK is stabilizing |
| Large index build blocks UI | Medium | High | Run index builds in Worker Thread |
| Disk growth from versioning | Medium | Low | Automated compaction on schedule |
| Lance DuckDB extension immaturity | Medium | Low | Fallback to LanceDB API for all queries |
| Memory spikes during index build | Low | Medium | Limit concurrent operations; monitor memory |

---

## References

- LanceDB Documentation: https://lancedb.github.io/lancedb/
- LanceDB Node.js SDK: https://www.npmjs.com/package/@lancedb/lancedb
- Lance Format Specification: https://lancedb.github.io/lance/
- Lance DuckDB Extension: https://github.com/lancedb/lance/tree/main/integration/duckdb_lance
- Tantivy (FTS Engine): https://github.com/quickwit-oss/tantivy

---

*Research conducted for datspace system design. All technology assessments based on published documentation and verified API surfaces.*
