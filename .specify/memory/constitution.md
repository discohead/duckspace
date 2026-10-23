<!--
  Sync Impact Report
  ===================
  Version change: N/A (template) -> 1.0.0 (initial ratification)

  Added principles:
    - I. Arrow-First Data Flow
    - II. Embedded-Only Databases
    - III. Stream and Scan
    - IV. Process Isolation
    - V. macOS-First
    - VI. Single-User, Local-First

  Added sections:
    - Core Principles (6 principles)
    - Technology Constraints (stack, bundle budget, storage)
    - Development Workflow (phased delivery, testing, AI safety)
    - Governance

  Removed sections: None (initial version)

  Templates requiring updates:
    - .specify/templates/plan-template.md ✅ compatible (Constitution Check gate present)
    - .specify/templates/spec-template.md ✅ compatible (no constitution-specific references)
    - .specify/templates/tasks-template.md ✅ compatible (phase structure aligns)
    - .specify/templates/checklist-template.md ✅ compatible (generic template)

  Deferred items: None

  Amendment 1.0.1 (2026-02-05):
    - Replaced apache-arrow JS (~500 KB) with @uwdata/flechette (~38 KB) in bundle budget
    - Flechette is the Arrow IPC decoder selected per research.md RQ-2
    - Arquero budget separated from Flechette for clarity
-->

# duckspace Constitution

## Core Principles

### I. Arrow-First Data Flow

All inter-component data transfer on the data plane MUST use Apache Arrow
IPC Stream format. JSON serialization in data-plane hot paths is a design
violation. JSON is permitted exclusively for control-plane messages (query
descriptors, ACK signals, lifecycle events, configuration).

**Rationale:** Arrow IPC preserves columnar type fidelity end-to-end
(database engine through visualization layer), enables zero-copy
`ArrayBuffer` transfer via `MessagePort`, and eliminates the
serialization/deserialization bottleneck that would otherwise dominate
large analytical result transfers.

**Enforcement:**
- Every `MessagePort` data channel (duckdb-data, lance-data, compute-data)
  carries Arrow IPC exclusively.
- No "small payload JSON fallback" is permitted -- this eliminates decision
  logic and maintains a single code path.
- The only unavoidable copy is at the N-API boundary (native C++/Rust to V8
  `ArrayBuffer`). All subsequent transfers use `ArrayBuffer` ownership move.

**Canonical references:** ADR-002, Design Doc 03 (Arrow Data Plane)

### II. Embedded-Only Databases

All database engines MUST run in-process within Electron. No external
database servers, no subprocess daemons, no network-accessible database
endpoints.

The three embedded databases and their roles:

| Database | Process | Role |
|----------|---------|------|
| DuckDB (native N-API addon) | Worker Thread #1 | OLAP analytics, columnar scans, aggregations, joins |
| LanceDB (native N-API addon) | Worker Thread #2 | Vector similarity search, Tantivy FTS, hybrid search (RRF) |
| Dexie.js (IndexedDB) | Renderer Process | Reactive UI state, metadata catalog, chat history, preferences |

**Rationale:** Each engine serves a fundamentally different workload. No
single database can serve OLAP, vector search, and reactive UI state
without being forced outside its design parameters. Three purpose-built
engines is the minimum viable configuration.

**Enforcement:**
- Arrow Flight, PostgreSQL, SQLite, and other external database approaches
  are explicitly rejected (see ADR-001, ADR-002).
- DuckDB and LanceDB use prebuilt N-API binaries; `electron-rebuild` is
  NOT required due to N-API ABI stability.
- Dexie.js runs in the Renderer (not Main) because reactive UI state
  belongs close to the UI -- `liveQuery()` operates without IPC. This is
  a documented Principle IV deviation.

**Canonical references:** ADR-001, Design Doc 04 (Database Integration)

### III. Stream and Scan

NEVER load full datasets into JavaScript memory. All data access MUST use
streaming, scanning, or predicate pushdown. DuckDB executes all filtering,
sorting, aggregation, and grouping using its columnar scan engine. The
Renderer receives only the rows it will display.

**Boundaries:**
- Chunked Arrow RecordBatch streaming with adaptive batch sizes
  (target 2 MB per batch).
- Window-based backpressure (window size 4, max ~8 MB in-flight per
  channel) prevents fast producers from overwhelming the Renderer.
- Predicate pushdown via `StructuredQueryDescriptor` compilation to
  parameterized SQL.
- Client-side filtering is permitted ONLY for small cross-filter
  interactions (< 5,000 rows already in the Renderer).
- Arquero operates on Arrow buffers via `fromArrow()` zero-copy wrapping;
  `toArray()` calls in the Observable Plot path are prohibited.

**Rationale:** JavaScript's single-threaded event loop and GC pause
characteristics make it unsuitable for holding multi-million-row datasets.
Pushing computation to DuckDB's vectorized SIMD engine is both faster and
more memory-efficient.

**Canonical references:** ADR-002 Section 4, Design Doc 03 Sections 3-4

### IV. Process Isolation

Each Electron process has a clearly defined responsibility. No process
may exceed its role.

```
Main Process (Node.js)
  OWNS: Lifecycle management, IPC dispatch, query routing, AI orchestration
  MUST NOT: Hold database connections, relay data-plane buffers, perform
  heavy computation

Worker Threads (V8 Isolates)
  #1 DuckDB:   Native addon, OLAP queries, Arrow IPC output
  #2 LanceDB:  Native addon, vector/FTS search, Arrow IPC output
  #3 Compute:  File parsing, Arrow transforms, data export
  #4 Embedding: Transformers.js/ONNX, local embedding generation

Renderer Process (Chromium, Sandboxed)
  OWNS: Visualization (Perspective, Observable Plot, ECharts), React UI,
  Dexie.js reactive state
  MUST NOT: Access filesystem, load native modules, make network requests
```

**Documented deviation:** Dexie.js runs in the Renderer (not a Worker)
because IndexedDB is Chromium-native and `liveQuery()` provides zero-IPC
reactive queries. This is an intentional Principle IV exception, not a
violation.

**Enforcement:**
- After `MessagePort` channel setup, query results flow directly from
  Worker Threads to the Renderer. The Main Process MUST NOT relay
  data-plane buffers.
- The Main Process relays only control messages and Embedding Worker
  vectors (Float32Array via Main relay to LanceDB Worker).

**Canonical references:** ADR-005, Design Doc 02 (Electron Process Model)

### V. macOS-First

All technology choices MUST work on macOS with Electron. Cross-platform
support is explicitly deferred and MUST NOT influence architectural
decisions.

**Implications:**
- Native addons target macOS arm64 and x64. Linux/Windows builds are
  not a current requirement.
- WebGL maps to Metal on macOS for GPU-accelerated visualization.
- `safeStorage` uses macOS Keychain for credential encryption.
- FSEvents (via chokidar) for filesystem watching.
- Application data stored at
  `~/Library/Application Support/Duckspace/`.

**Canonical references:** Design Doc 01 Section 1, Design Doc 02

### VI. Single-User, Local-First

duckspace is designed for a single user working locally. There is no
multi-user synchronization, no authentication system, and no
collaboration features. The application MUST work offline for all local
data operations. Remote connectors MUST degrade gracefully when the
network is unavailable (serve stale cached data with a warning).

**Implications:**
- No authentication or authorization layer.
- No conflict resolution or multi-writer coordination.
- Local embeddings via Transformers.js (no external embedding API calls).
- Claude Agent SDK uses local Claude Code installation and Claude Max
  subscription -- no API keys, no per-query cost tracking.
- Remote connector data is cached in DuckDB with TTL-based invalidation
  and LRU eviction (2 GB budget). Offline mode serves stale cache.

**Canonical references:** Design Doc 01 Section 1, Design Doc 07 Section 6

## Technology Constraints

### Mandated Technology Stack

The following technology choices are binding architectural decisions.
Substitutions require a new ADR and constitution amendment.

| Category | Technology | ADR |
|----------|-----------|-----|
| Runtime | Electron v28+ (Chromium + Node.js) | ADR-005 |
| OLAP Database | DuckDB (native N-API addon) | ADR-001 |
| Vector Database | LanceDB (native N-API addon) | ADR-001 |
| Reactive State | Dexie.js (IndexedDB, `liveQuery`) | ADR-001 |
| Data Interchange | Apache Arrow IPC (Stream format) | ADR-002 |
| IPC Transport | MessagePort (`ArrayBuffer` transfer) | ADR-002 |
| Data Grid | Perspective.js (WASM + WebGL) | ADR-003 |
| Statistical Charts | Observable Plot (SVG) | ADR-003 |
| Dashboard Charts | ECharts + echarts-gl (Canvas) | ADR-003 |
| Data Wrangling | Arquero (`fromArrow()` zero-copy) | ADR-003 R4 |
| AI Conversation | Claude Agent SDK (autonomous agent loop) | ADR-004 R3 |
| Tool Protocol | MCP (Model Context Protocol, in-process) | ADR-004 R3 |
| Embeddings | Transformers.js (all-MiniLM-L6-v2, 384-dim) | ADR-004 |
| UI Framework | React + react-grid-layout | ADR-003 |

### Technology Correction Notes

These corrections supersede any earlier or conflicting references:
- **Reactive State:** Dexie.js (NOT RxDB). See ADR-001 Revision 2.
- **AI SDK:** Claude Agent SDK (NOT Anthropic Client SDK). See ADR-004
  Revision 3.
- **Data Wrangling:** Arquero for Renderer-side Arrow table operations.
  See ADR-003 Revision 4.
- **Visualization:** Observable Plot + ECharts for charting. Perspective.js
  is for data grid only (NOT dashboards).

### Bundle Size Budget

Total application size MUST remain within 260-340 MB. Individual component
budgets:

| Component | Budget |
|-----------|--------|
| Electron baseline | 150-200 MB |
| DuckDB + extensions | 53-73 MB |
| LanceDB N-API addon | 15-25 MB |
| Perspective.js (WASM + JS) | ~10 MB |
| Transformers.js + ONNX model | ~31 MB |
| ECharts (tree-shaken + gl) | ~500 KB |
| Observable Plot | ~150 KB |
| Arquero | ~115 KB |
| @uwdata/flechette (Arrow IPC decoder) | ~38 KB |
| Dexie.js + React hooks | ~83 KB |

### Storage Locations

All persistent data resides under
`~/Library/Application Support/Duckspace/`:

| Store | Path | Engine |
|-------|------|--------|
| Analytics database | `analytics.duckdb` | DuckDB |
| Vector indices | `lance/` | LanceDB |
| UI state | `IndexedDB/` | Dexie.js |
| Encrypted credentials | `credentials.enc` | safeStorage |
| Configuration | `config.json` | JSON |
| DuckDB spill | `tmp/` | DuckDB |
| Embedding models | `models/` | Transformers.js |

## Development Workflow

### Phased Delivery

duckspace is delivered incrementally across seven phases. Each phase
produces a functional increment that builds on previous phases.
Implementation MUST follow this ordering -- no phase may begin before
its dependencies are complete.

| Phase | Name | Dependencies |
|-------|------|-------------|
| 1 | Foundation (Electron + DuckDB + Arrow IPC) | None |
| 2 | Local Data (ingestion + catalog + data grid) | Phase 1 |
| 3 | Remote Connectors (S3, BigQuery, SaaS) | Phase 2 |
| 4 | Advanced Visualization (Plot, ECharts, dashboards) | Phase 2 |
| 5 | AI Integration (Claude Agent SDK, MCP, RAG) | Phase 2, 4 |
| 6 | Publishing (export, static HTML, viewers) | Phase 4, 5 |
| 7 | Polish (performance, UX, accessibility) | Phase 3, 4, 5, 6 |

### AI Safety Enforcement

All AI-generated SQL MUST pass through a defense-in-depth safety pipeline
with five layers. No layer may be bypassed:

1. **allowedTools restriction** -- Claude Agent SDK limits available tools.
2. **PreToolUse hook** -- Intercepts tool calls before execution.
3. **Regex validation** -- Rejects mutation keywords (INSERT, UPDATE,
   DELETE, DROP, ALTER, TRUNCATE, CREATE TABLE, GRANT, REVOKE).
4. **Read-only DuckDB connection** -- Database-level write protection.
5. **Query timeout + row limit** -- Resource exhaustion prevention.

### Design Documentation

The architecture is defined across 20+ artifacts in `context/artifacts/`.
All implementation MUST conform to these specifications:

- **Design docs** (00-10): Architecture, process model, data plane,
  databases, vector search, ingestion, connectors, visualization, AI,
  publishing
- **ADRs** (001-005): Database trio, Arrow data plane, visualization
  stack, AI integration, process architecture
- **Specs**: Data model spec, IPC/API spec
- **Validation**: Cross-reference report

When a conflict exists between this constitution and a design document,
this constitution takes precedence. When a conflict exists between design
documents, the Architecture Overview (00) takes precedence.

### Testing and Quality

- Every feature spec MUST include measurable acceptance criteria.
- Arrow IPC round-trip integrity MUST be verified for any new data channel.
- Backpressure flow control MUST be validated for streaming data paths.
- Memory budgets (DuckDB: 50% RAM, Arrow cache: 256 MB LRU, total cache:
  2 GB) MUST be enforced and tested under load.
- Application startup MUST complete in under 2 seconds on reference
  hardware (macOS, 16 GB RAM).

## Governance

This constitution is the supreme governing document for duckspace
development. It supersedes all other practices, guidelines, and ad-hoc
decisions. When any specification, plan, or implementation conflicts with
a principle defined here, this constitution prevails.

**Amendment procedure:**
1. Propose amendment as a new ADR in `context/artifacts/decisions/`.
2. Document the principle change, rationale, and migration impact.
3. Update this constitution file with the amendment.
4. Increment version per semantic versioning (see below).
5. Update all dependent artifacts flagged in the Sync Impact Report.

**Versioning policy:**
- MAJOR: Backward-incompatible governance or principle removal/redefinition.
- MINOR: New principle or section added, or material expansion of guidance.
- PATCH: Clarifications, wording refinements, non-semantic changes.

**Compliance review:**
- Every feature plan MUST include a Constitution Check gate (see
  plan-template.md) that verifies alignment with all six core principles.
- Code reviews MUST verify that data-plane code uses Arrow IPC (Principle I)
  and that no database runs out-of-process (Principle II).
- Runtime guidance for development is anchored in the design documentation
  corpus at `context/artifacts/`.

**Version**: 1.0.1 | **Ratified**: 2026-02-05 | **Last Amended**: 2026-02-05
