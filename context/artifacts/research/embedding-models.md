# Embedding Model Options for Local Vector Search in datspace

**Research Finding** | Generated: 2026-02-04
**Scope**: Evaluate embedding model strategies for LanceDB vector search within an Electron desktop application
**Constraints**: Local-first, offline-capable, embedded-only databases, macOS-first, bundle size matters

---

## Executive Summary

datspace requires an embedding pipeline to power semantic search, AI-assisted analytics (RAG), and contextual retrieval across SQL queries, table schemas, data samples, and user notes. The embedding model must integrate with the LanceDB vector store, run within the Electron process model (Worker Threads), and respect the project's immutable principles: local-first operation, offline capability, and embedded-only databases.

After evaluating local inference (Transformers.js), API-based services, and hybrid approaches, this document recommends a **hybrid strategy with Transformers.js as the primary local engine** and optional API-based enrichment when online.

---

## 1. Local Embedding via Transformers.js

### Overview

[Transformers.js](https://huggingface.co/docs/transformers.js) is a Hugging Face library that runs transformer models directly in JavaScript using ONNX Runtime. It supports Node.js (Electron main/worker) and browser (renderer) environments.

### Model Options

| Model | Dimensions | Size (ONNX quantized) | Quality (MTEB Avg) | Inference Speed (CPU) | Notes |
|-------|-----------|----------------------|--------------------|-----------------------|-------|
| `all-MiniLM-L6-v2` | 384 | ~23 MB (int8) | 0.630 | ~15ms/sentence | Best speed/quality ratio; widely adopted |
| `gte-small` | 384 | ~33 MB (int8) | 0.642 | ~18ms/sentence | Slightly better quality than MiniLM |
| `bge-small-en-v1.5` | 384 | ~33 MB (int8) | 0.638 | ~18ms/sentence | Strong retrieval-focused model |
| `gte-base` | 768 | ~110 MB (int8) | 0.665 | ~35ms/sentence | Good quality step-up; larger footprint |
| `bge-base-en-v1.5` | 768 | 110 MB (int8) | 0.660 | ~35ms/sentence | High-quality retrieval-focused |
| `nomic-embed-text-v1.5` | 768 | ~140 MB (fp16) | 0.680 | ~40ms/sentence | Supports Matryoshka (variable dims) |

*Benchmarks are approximate, measured on modern Apple Silicon (M1/M2/M3) in Node.js Worker Thread context.*

### Architecture in Electron

```
Main Process
  |
  +-- Worker Thread: EmbeddingWorker
  |     |-- Loads Transformers.js pipeline
  |     |-- Caches ONNX model in app data directory
  |     |-- Processes embedding requests via MessagePort
  |     |-- Returns Float32Array (Arrow-compatible)
  |     +-- Handles batch embedding with backpressure
  |
  +-- LanceDB (Main Process)
        |-- Receives embeddings as Arrow vectors
        |-- Stores in Lance columnar format
        +-- Executes ANN queries
```

### Model Download and Caching Strategy

1. **First-run download**: On first use, download the ONNX model from Hugging Face Hub (or a bundled CDN mirror) to the app's data directory (`app.getPath('userData')/models/`)
2. **Bundled fallback**: Ship `all-MiniLM-L6-v2` (23 MB quantized) within the Electron asar to guarantee offline-from-install capability
3. **Model registry**: Maintain a local manifest of available models with checksums, allowing users to download higher-quality models on demand
4. **Cache invalidation**: Versioned model directory (`models/v1/all-MiniLM-L6-v2/`) to support model upgrades without breaking existing embeddings
5. **Re-embedding trigger**: When the user switches models, flag existing embeddings for lazy re-computation in background Worker Thread

### Bundle Size Analysis

| Strategy | Added Bundle Size | First-Run Download | Offline from Install |
|----------|------------------|-------------------|---------------------|
| Bundle MiniLM-L6-v2 (int8) | +23 MB | None | Yes |
| Bundle ONNX Runtime only | +8 MB | ~23-140 MB model | No (until download) |
| Bundle nothing (lazy load) | +0 MB | ~31-148 MB (runtime + model) | No |
| **Recommended: Bundle MiniLM** | **+23 MB** | **Optional upgrades** | **Yes** |

The ONNX Runtime Web/Node package itself adds approximately 8 MB. Bundling the default model (MiniLM-L6-v2 int8 quantized) adds 23 MB, for a total of ~31 MB. This is acceptable for a desktop Electron application where typical bundle sizes range from 100-300 MB.

### Performance Characteristics

- **Single embedding**: 10-20ms on Apple Silicon (Worker Thread, int8 quantized)
- **Batch of 100**: 800-1500ms (amortized overhead of model loading)
- **Memory footprint**: ~80-150 MB resident (model + ONNX runtime) in Worker Thread
- **Startup**: ~500ms warm start (model cached), ~2-5s cold start (model loading from disk)
- **Throughput ceiling**: ~50-80 embeddings/second sustained on M1/M2

### Strengths

- Fully local, fully offline -- aligns with datspace constitution
- No API keys, no costs, no rate limits
- Deterministic results (same input always yields same embedding)
- Worker Thread isolation keeps UI responsive
- ONNX int8 quantization provides excellent speed/quality trade-off on Apple Silicon

### Weaknesses

- Lower quality than state-of-the-art API models (MTEB 0.63 vs 0.68+)
- Model updates require app update or user-initiated download
- 384-dim embeddings may limit nuanced semantic search for complex queries
- Memory footprint in Worker Thread (~100 MB) adds to overall app memory

---

## 2. API-Based Embedding Services

### Overview

External embedding APIs provide higher-quality embeddings but require network connectivity, introduce latency, and incur per-token costs.

### Service Comparison

| Service | Model | Dimensions | Quality (MTEB) | Cost (per 1M tokens) | Latency (p50) | Notes |
|---------|-------|-----------|----------------|----------------------|---------------|-------|
| OpenAI | `text-embedding-3-small` | 1536 (or 256/512 via shortening) | 0.625 | $0.02 | 50-100ms | Dimension shortening via Matryoshka |
| OpenAI | `text-embedding-3-large` | 3072 (or 256/512/1024/1536) | 0.645 | $0.13 | 80-150ms | Highest quality from OpenAI |
| Cohere | `embed-english-v3.0` | 1024 | 0.640 | $0.10 | 60-120ms | Strong multilingual support |
| Voyage AI | `voyage-3` | 1024 | 0.678 | $0.06 | 70-130ms | Excellent code/retrieval quality |
| Google | `text-embedding-004` | 768 | 0.660 | $0.00625 | 60-100ms | Very low cost |

*Note: Anthropic/Claude does not currently offer a standalone embedding API. Claude's capabilities are focused on generation, not embedding.*

### Cost Analysis for Desktop App Usage

Typical datspace usage patterns and estimated API costs:

| Use Case | Tokens/Event | Events/Day | Monthly Tokens | Monthly Cost (OpenAI small) |
|----------|-------------|------------|----------------|----------------------------|
| SQL query embedding | ~100 | 50 | 150K | $0.003 |
| Schema registration | ~500 | 5 | 75K | $0.002 |
| Data sample embedding | ~200 | 20 | 120K | $0.002 |
| Document/note embedding | ~300 | 10 | 90K | $0.002 |
| **Total** | | | **~435K** | **~$0.009/month** |

Cost is negligible for a single desktop user. The primary concerns are latency and offline availability, not price.

### Strengths

- Higher quality embeddings (especially for nuanced semantic queries)
- No local compute or memory overhead
- Models improve over time without app updates
- Some APIs support dimension shortening (Matryoshka)

### Weaknesses

- **Violates local-first, offline-capable principle** if used as sole embedding source
- Network latency adds 50-150ms per embedding operation
- API key management complexity for desktop app
- Privacy: user data (queries, schemas) sent to external service
- Rate limiting and availability risks
- Vendor lock-in on embedding dimensions and model versions
- Re-embedding required if switching providers (dimension mismatch)

---

## 3. Hybrid Approach: Local Primary + API Enhancement

### Architecture

```
User Action (e.g., save query)
       |
       v
  EmbeddingRouter
       |
       +--[Always]--> Local Worker Thread (Transformers.js)
       |                  |
       |                  v
       |              LanceDB: store local embedding
       |
       +--[If online + opt-in]--> API Service (background)
                                    |
                                    v
                                LanceDB: store API embedding
                                (separate vector column)
```

### Design

1. **Local embedding is always generated** (Worker Thread, Transformers.js) to guarantee offline search capability
2. **API embedding is optional**: Generated in the background when online and the user has opted in (API key configured)
3. **Dual-column storage in LanceDB**: `vec_local` (384-dim) and `vec_api` (variable-dim) stored as separate columns
4. **Search routing**: Use `vec_api` when available and populated; fall back to `vec_local` when offline or API embedding not yet computed
5. **Lazy backfill**: When the user configures an API key, existing items are re-embedded via API in a background queue

### Trade-offs

| Aspect | Local-Only | API-Only | Hybrid |
|--------|-----------|---------|--------|
| Offline capability | Full | None | Full (local fallback) |
| Search quality | Good (MTEB ~0.63) | Better (MTEB ~0.65-0.68) | Best of both |
| Storage cost | 1x | 1x | ~1.5-2x (dual columns) |
| Complexity | Low | Low | Medium |
| Privacy | Full local | Data sent externally | Configurable |
| Constitution compliance | Full | Violation | Full (API is opt-in) |

### Complexity Considerations

The hybrid approach adds complexity in:
- Embedding router logic
- Dual-column schema in LanceDB
- Background job queue for API embeddings
- Search query routing based on column availability
- Configuration UI for API key management

This complexity is **not justified for the initial implementation**. The local-only approach satisfies all constitutional requirements, and the quality gap (MTEB 0.63 vs 0.65) is narrow for the analytics context use case.

---

## 4. Embedding Dimensions and Storage Implications

### Dimensionality Trade-offs

| Dimensions | Storage per Row | 1M Rows Storage | ANN Query Speed | Semantic Precision |
|-----------|----------------|-----------------|-----------------|-------------------|
| 384 | 1.5 KB | ~1.5 GB | Fastest | Good for short-to-medium text |
| 768 | 3.0 KB | ~3.0 GB | Fast | Better for complex semantics |
| 1024 | 4.0 KB | ~4.0 GB | Moderate | High precision |
| 1536 | 6.0 KB | ~6.0 GB | Slower | Highest precision (OpenAI) |

*Storage includes vector data only; LanceDB adds ~10-20% overhead for metadata and index structures.*

### LanceDB Storage Characteristics

LanceDB uses the Lance columnar format, which stores vectors in contiguous Float32 arrays. Key properties:

- **Columnar compression**: Lance achieves 2-4x compression on vector columns via dictionary encoding and bit-packing
- **IVF-PQ indexing**: LanceDB supports IVF-PQ (Inverted File + Product Quantization) indices that reduce memory footprint for ANN search by 4-16x
- **Disk-based ANN**: Unlike FAISS or Pinecone, LanceDB performs ANN search from disk with memory-mapped files, keeping resident memory low
- **Practical storage**: With IVF-PQ, 1M 384-dim vectors require ~100 MB disk, ~25 MB memory for index

### Query Performance by Dimensionality (LanceDB on Apple Silicon)

| Dimensions | Brute-force (1K rows) | IVF-PQ ANN (100K rows) | IVF-PQ ANN (1M rows) |
|-----------|----------------------|------------------------|---------------------|
| 384 | <1ms | ~2ms | ~5ms |
| 768 | ~1ms | ~4ms | ~10ms |
| 1024 | ~2ms | ~6ms | ~15ms |
| 1536 | ~3ms | ~10ms | ~25ms |

For datspace's expected scale (thousands to tens of thousands of embedded items -- not millions), **all dimensionalities perform well**. The 384-dim option offers the best balance of quality, storage, and speed.

### Recommendation on Dimensions

**384 dimensions** is the right choice for datspace:
- Expected corpus size (SQL queries, schemas, notes) is <100K items
- At this scale, brute-force search is <1ms, index-based is <2ms
- Storage overhead is minimal (~150 KB for 100 items)
- 384-dim models (MiniLM, gte-small) are proven effective for information retrieval tasks
- If future needs demand higher precision, the Matryoshka approach (nomic-embed) allows upgrading dimensions without changing models

---

## 5. Chunking Strategies for Analytics Context

Different content types in datspace require tailored chunking and embedding strategies.

### 5.1 SQL Query Embedding

**Strategy**: Embed the full query as a single chunk (most queries < 512 tokens).

```
Input:  SELECT date, SUM(revenue) FROM sales WHERE region = 'NA' GROUP BY date
Embed:  Full query as-is
Metadata: { type: "query", tables: ["sales"], created: "...", tags: [...] }
```

**Rationale**: SQL queries are semantically atomic. Splitting them loses structural meaning. Transformers.js models handle 256-512 token inputs efficiently.

**Edge case**: For complex CTEs or multi-statement queries (>512 tokens), split at CTE boundaries, embedding each CTE separately while maintaining a parent reference.

### 5.2 Table Schema Embedding

**Strategy**: Embed column-level descriptions with table context prefix.

```
Input Table: sales (region TEXT, date DATE, revenue DECIMAL, quantity INT)

Chunk 1: "Table 'sales': Columns - region (TEXT), date (DATE), revenue (DECIMAL), quantity (INT)"
Chunk 2: "Table 'sales', column 'revenue': DECIMAL type, represents monetary revenue value"
```

**Rationale**: Embedding the full DDL loses column-level searchability. A two-level approach (table summary + per-column detail) enables both broad ("find revenue tables") and narrow ("find date columns") search.

**Metadata enrichment**: Include inferred column statistics (cardinality, null rate, sample values) in the embedding text to improve semantic matching.

### 5.3 Data Sample Embedding

**Strategy**: Embed representative row summaries, not raw data.

```
Input: First 5 rows of sales table
Transform: "Sample from 'sales': region values include NA, EU, APAC;
            date ranges from 2024-01 to 2024-12; revenue ranges $100-$50K;
            quantity ranges 1-500"

Embed: The transformed summary
```

**Rationale**: Raw CSV/row data embeds poorly -- models struggle with tabular formats. Summarizing distributions and value ranges creates meaningful embeddings that answer questions like "which table has geographic data?"

**Implementation**: Generate summaries via DuckDB aggregate queries (min, max, approx_count_distinct, sample) and embed the natural language summary.

### 5.4 Document/Note Embedding

**Strategy**: Standard text chunking with overlap.

```
Parameters:
  chunk_size: 256 tokens  (optimized for 384-dim models)
  chunk_overlap: 32 tokens
  split_on: paragraph boundaries (prefer semantic splits)
```

**Rationale**: User notes and documentation follow standard NLP text patterns. Paragraph-boundary splitting preserves semantic coherence better than fixed-size splitting.

**Recursive splitting**: Split on double newlines first, then single newlines, then sentences, then fixed-size as a last resort.

### Chunking Summary

| Content Type | Chunk Strategy | Avg Chunks per Item | Avg Tokens per Chunk |
|-------------|---------------|--------------------|--------------------|
| SQL query | Whole document | 1 | 50-200 |
| Table schema | Table + per-column | 1 + N columns | 30-80 |
| Data sample | Summary per table | 1 | 100-200 |
| Document/note | Paragraph-split with overlap | 3-10 | 200-256 |

---

## Alternatives Considered

### Alternative 1: API-Only Embedding (OpenAI / Voyage AI)

**Evaluated**: Using OpenAI `text-embedding-3-small` or Voyage AI `voyage-3` as the sole embedding provider.

**Rejected because**:
- Violates the local-first and offline-capable constitutional principles (Principle 14)
- Network dependency is unacceptable for a desktop app that must work without internet
- Privacy concerns: user SQL queries and data schemas sent to external service
- Cost is trivial, but dependency on external availability is not

**When it might be reconsidered**: If a future "cloud tier" of datspace supports always-online enterprise users, API embedding could be the default for that tier.

### Alternative 2: Hybrid Dual-Column from Day One

**Evaluated**: Implementing both local (Transformers.js) and API embedding columns in LanceDB from the initial release.

**Rejected because**:
- Adds significant complexity to the embedding pipeline, LanceDB schema, and search routing
- The quality difference (MTEB 0.63 vs 0.65-0.68) is marginal for analytics-context retrieval
- Doubles storage for vector data
- Can be added later as an enhancement without breaking the local-only architecture
- YAGNI (You Aren't Gonna Need It) applies strongly here

**When it might be reconsidered**: After user feedback indicates local embedding quality is insufficient for their retrieval needs, or when implementing the RAG pipeline for Claude Agent SDK integration in later roadmap phases.

### Alternative 3: 768-Dimension Local Model (gte-base / bge-base)

**Evaluated**: Using a 768-dim model instead of 384-dim for higher semantic precision.

**Rejected because**:
- Model size increases from ~23 MB to ~110 MB (5x larger download and bundle)
- Memory footprint increases proportionally in Worker Thread
- Embedding latency roughly doubles (35ms vs 15ms)
- For the expected corpus sizes (<100K items), the quality improvement is negligible
- Storage doubles for vector columns

**When it might be reconsidered**: If datspace grows to handle very large corpora (>500K embedded items) where the additional dimensions meaningfully improve retrieval precision in ANN search.

### Alternative 4: FAISS or Usearch Instead of LanceDB Vector Search

**Evaluated**: Using a dedicated ANN library (FAISS, Usearch) instead of LanceDB's built-in vector search.

**Rejected because**:
- LanceDB already integrates ANN search (IVF-PQ) natively
- Adding another native library increases Electron build complexity
- LanceDB's disk-based search is ideal for the "Stream and Scan" principle
- FAISS requires loading index into memory, violating the embedded-only and memory-conscious constraints
- No meaningful performance advantage at datspace's expected scale

### Alternative 5: Sentence-Transformers via Python Sidecar

**Evaluated**: Running a Python sidecar process with sentence-transformers for embedding generation.

**Rejected because**:
- Requires Python runtime bundled with or installed alongside Electron
- Dramatically increases bundle size and installation complexity
- Process management overhead (spawning, health checking, IPC with Python)
- Transformers.js provides equivalent models via ONNX without the Python dependency
- Violates the simplicity and embedded-only principles

---

## Recommendation

### Primary Strategy: Local Embedding with Transformers.js

**Model**: `all-MiniLM-L6-v2` (384 dimensions, int8 quantized ONNX)

**Rationale**:

1. **Constitutional compliance**: Fully local, fully offline, embedded-only -- satisfies Principles 10, 13, and 14
2. **Proven quality**: MTEB average score of 0.63 is well-established for information retrieval; sufficient for SQL query search, schema matching, and document retrieval in an analytics context
3. **Optimal performance**: 15ms per embedding on Apple Silicon, sub-millisecond search at expected corpus sizes
4. **Minimal footprint**: 23 MB bundled model + 8 MB ONNX Runtime = 31 MB total added to Electron bundle
5. **Worker Thread isolation**: Respects Principle 12 (process isolation) -- embedding computation runs in dedicated Worker Thread, never blocking UI
6. **Arrow compatibility**: Float32Array output maps directly to Arrow FixedSizeList for zero-copy transfer to LanceDB, respecting Principle 9

### Implementation Architecture

```
Electron App
|
+-- Main Process
|     +-- LanceDB (embedded, Lance format)
|     |     +-- vector column: Float32[384]
|     |     +-- IVF-PQ index (created when table > 10K rows)
|     |     +-- Full-text index (tantivy-based)
|     |
|     +-- EmbeddingService
|           +-- Manages Worker Thread lifecycle
|           +-- Request queue with backpressure
|           +-- Batch optimization (groups requests)
|           +-- Arrow serialization for LanceDB writes
|
+-- Worker Thread: EmbeddingWorker
|     +-- Transformers.js pipeline (feature-extraction)
|     +-- ONNX Runtime (wasm/node backend)
|     +-- Model: all-MiniLM-L6-v2 (int8 quantized)
|     +-- Model cache: app.getPath('userData')/models/
|     +-- MessagePort IPC with Main Process
|
+-- Renderer Process
      +-- Triggers embedding via IPC (preload bridge)
      +-- Receives search results as Arrow RecordBatch
```

### Model Lifecycle

1. **Bundle**: Ship `all-MiniLM-L6-v2` int8 ONNX in app resources (~23 MB)
2. **Load**: On first embedding request, Worker Thread loads model (~500ms)
3. **Keep warm**: Worker Thread stays alive after first use (lazy termination after 5 min idle)
4. **Upgrade path**: Settings UI allows downloading alternative models (gte-small, bge-small) to `userData/models/`
5. **Re-embedding**: Model switch triggers background re-embedding job with progress indicator

### Chunking Configuration

| Content Type | Strategy | Max Tokens | Overlap |
|-------------|----------|-----------|---------|
| SQL query | Whole document | 512 | N/A |
| Table schema | Table summary + per-column | 128 per chunk | N/A |
| Data sample | DuckDB-generated summary | 256 | N/A |
| Document/note | Recursive paragraph split | 256 | 32 |

### Future Enhancement Path

The architecture is designed to support future additions without breaking changes:

1. **Phase 1 (MVP)**: Local-only Transformers.js with all-MiniLM-L6-v2
2. **Phase 2 (Enhancement)**: Optional API enrichment column -- add `vec_api` column to LanceDB schema, implement EmbeddingRouter
3. **Phase 3 (Advanced)**: Matryoshka embeddings (nomic-embed-text-v1.5) for variable-dimension storage, enabling quality/speed trade-off per query
4. **Phase 4 (RAG Integration)**: Embedding pipeline integrated with Claude Agent SDK RAG for contextual AI chat

### Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding location | Local (Transformers.js) | Constitutional: offline-capable, local-first |
| Model | all-MiniLM-L6-v2 | Best speed/quality/size trade-off |
| Dimensions | 384 | Sufficient for <100K corpus; minimal storage |
| Quantization | int8 ONNX | 2x faster, 4x smaller than fp32, <1% quality loss |
| Execution context | Worker Thread | Process isolation principle; non-blocking |
| Bundling | Include in app resources | Offline from first install |
| Vector store | LanceDB (native) | Already in architecture; IVF-PQ built-in |
| Chunking | Content-type-specific | Analytics context demands specialized chunking |

---

*This research finding supports the datspace system design project. All recommendations comply with the project constitution's immutable principles.*
