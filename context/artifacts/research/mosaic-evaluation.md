# Mosaic Framework Evaluation for datspace

**Date:** 2026-02-05
**Purpose:** Evaluate UW IDL's Mosaic framework for integration with datspace
**Sources:** idl.uw.edu/mosaic, github.com/uwdata/mosaic

---

## 1. What is Mosaic?

Mosaic is an extensible framework for linking data visualizations, tables, input widgets, and other data-driven components, leveraging a database backend (DuckDB) for scalable processing. Developed by UW Interactive Data Lab — the same team behind Arquero, Observable Plot, D3, Vega-Lite, and Flechette.

- **Version:** 0.21.1 (October 2025, pre-1.0)
- **License:** BSD
- **Repository:** github.com/uwdata/mosaic
- **28 releases** since initial release

### Core Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│   Client A   │────▶│   Coordinator   │────▶│   DuckDB     │
│  (vgplot)    │◀────│  (query opt,    │◀────│  (WASM or    │
│              │     │   cache, route)  │     │   native)    │
├──────────────┤     │                 │     └──────────────┘
│   Client B   │────▶│   Selections    │          │
│  (ECharts?)  │◀────│  (SQL WHERE     │          │ Apache Arrow
│              │     │   predicates)   │          │
├──────────────┤     │                 │          ▼
│   Client C   │────▶│   Params        │     ┌──────────────┐
│  (Input)     │◀────│  (shared vals)  │     │  Arrow IPC   │
└──────────────┘     └─────────────────┘     │  results     │
                                              └──────────────┘
```

**Coordinator:** Central hub that receives queries from clients, optimizes them (e.g., creating materialized views of pre-aggregated data), caches results, and routes to DuckDB. Returns Apache Arrow buffers.

**Clients:** Any component implementing the Mosaic client interface: `fields()`, `query()`, `queryPending()`, `queryResult()`, `queryError()`. Clients declare a `filterBy` Selection for automatic cross-filtering.

**Selections:** Reactive predicates (SQL WHERE clauses) with resolution strategies: `single`, `union`, `intersect`, `crossfilter`. When a user interacts with one visualization, the selection updates propagate to all coordinated clients.

**Params:** Reactive scalar values shared across components.

## 2. Package Inventory

| Package | npm | Purpose | Standalone? |
|---------|-----|---------|-------------|
| `mosaic-core` | `@uwdata/mosaic-core` | Coordinator, Params, Selections, filter groups | Yes |
| `mosaic-sql` | `@uwdata/mosaic-sql` | Programmatic SQL query construction | **Yes** (fully standalone) |
| `vgplot` | `@uwdata/vgplot` | Grammar of graphics on Observable Plot | Needs mosaic-core |
| `mosaic-plot` | `@uwdata/mosaic-plot` | Lower-level Plot integration | Needs mosaic-core |
| `mosaic-inputs` | `@uwdata/mosaic-inputs` | Data-driven widgets | Needs mosaic-core |
| `mosaic-spec` | `@uwdata/mosaic-spec` | Declarative JSON/YAML dashboard specs | Needs mosaic-core |
| `mosaic-duckdb` | `@uwdata/mosaic-duckdb` | Node.js DuckDB connector (N-API) | **Deprecated** |

## 3. Package-by-Package Evaluation

### 3.1 `mosaic-sql` — ADOPT

**What it provides:**
- `Query` class with chainable SQL construction: `select()`, `from()`, `where()`, `groupby()`, `having()`, `window()`, `qualify()`, `orderby()`, `limit()`, `offset()`
- Common Table Expressions via `with()`
- Subquery support (pass Query as FROM)
- DuckDB aggregate functions: `min`, `max`, `count`, `sum`, `avg`, `stddev`, `median`, `quantile`, `argmax`, `argmin`, `corr`
- Window functions: `row_number`, `rank`, `cume_dist`, `lag`, `lead`
- Template literal syntax: `` sql`log(foo + 1)` ``
- Data loading helpers: `loadCSV()`, `loadJSON()`, `loadParquet()`, `loadObjects()`
- Expression visitors to extract column/param references

**Example:**
```javascript
import { Query, avg, count, desc } from '@uwdata/mosaic-sql';

const query = Query
  .from('events')
  .select({ category: 'category', avg_value: avg('value'), cnt: count() })
  .where(`timestamp >= '2026-01-01'`)
  .groupby('category')
  .having(count().gt(10))
  .orderby(desc('cnt'))
  .limit(100);

// Coerces to SQL string:
// SELECT category, AVG(value) AS avg_value, COUNT(*) AS cnt
// FROM events WHERE timestamp >= '2026-01-01'
// GROUP BY category HAVING COUNT(*) > 10
// ORDER BY cnt DESC LIMIT 100
```

**datspace alignment:**

| Current Pattern | Mosaic SQL Replacement |
|----------------|----------------------|
| `buildTimeSeriesQuery()` — hand-written SQL template | `Query.from(table).select({...}).where(...).groupby(timeBucket)` |
| `buildEChartsQuery()` — manual aggregation SQL | `Query.from(table).select({x, y: avg(col)}).groupby(x)` |
| Cross-filter WHERE clauses — string concatenation | `query.where(selection.predicate())` |
| `loadParquet()` in DuckDB — manual `COPY` commands | `loadParquet(table, path, options)` |

**Risk:** Low. Standalone, no side effects, pure SQL generation.
**Bundle size:** Small — SQL builder logic only, no runtime dependencies.
**Recommendation:** **Adopt.** Replace hand-written SQL strings in visualization query builders during implementation.

### 3.2 `mosaic-core` (Coordinator + Selections) — EVALUATE AT IMPLEMENTATION

**What it provides:**
- **Coordinator:** Central query routing with optimization (consolidates duplicate queries, builds materialized pre-aggregation views, caches results)
- **Selections:** Cross-filter coordination. Four resolution strategies: `single` (one active predicate), `union` (OR), `intersect` (AND), `crossfilter` (each client excluded from its own predicate — the standard cross-filter pattern)
- **Filter Groups:** Automatic materialized views of pre-aggregated data for fast interactive filtering
- **Client Interface:** `connect(coordinator)` → `fields()` → `query()` → `queryResult(data)` lifecycle

**datspace alignment:**

| datspace Component | Mosaic Core Equivalent |
|---------------------|----------------------|
| CrossFilterManager (Section 5.3 of 08) | Selections with `crossfilter` resolution |
| SQL WHERE predicate propagation | Selection `predicate()` method |
| Debounced filter events (100-200ms) | Built into Coordinator query batching |
| DuckDB query routing (Section 5 of 04) | Coordinator with custom connector |
| ArrowResultCache (LRU, 256MB) | Coordinator result caching + filter group materialization |

**Custom Connector Feasibility:**

The critical question: can the Mosaic Coordinator run in datspace's Renderer process and talk to DuckDB in a Worker Thread?

```
Current datspace:
  Renderer → MessagePort → DuckDB Worker Thread → Arrow IPC → Renderer

Mosaic Coordinator in Renderer:
  Client → Coordinator.query(sql) → ???connector??? → DuckDB Worker → Arrow → Coordinator → Client
```

The `@uwdata/mosaic-duckdb` package proves native DuckDB works:
```javascript
class DuckDB {
  constructor(path) { /* uses duckdb npm N-API binding */ }
  async query(sql) { /* returns JS objects */ }
  async arrowBuffer(sql) { /* returns Arrow IPC buffer */ }
  close() { /* cleanup */ }
}
```

A custom connector for datspace would need to:
1. Implement the Mosaic connector interface (query → Arrow result)
2. Bridge to our existing MessagePort → DuckDB Worker architecture
3. Return Arrow IPC buffers (which Mosaic already expects)

**Estimated effort:** ~100-200 lines of adapter code. The interface is simple; the complexity is in mapping Mosaic's synchronous-looking API to our async Worker Thread pattern.

**Perspective.js as Mosaic Client:** Perspective already has a query model (config → SQL → Arrow). Wrapping it as a Mosaic client requires implementing `query()` to return Perspective's SQL needs and `queryResult()` to feed Arrow data. Feasible but non-trivial (~200-300 lines).

**Risk:** Medium. Pre-1.0 API, custom connector + Perspective wrapper development. If Mosaic changes its connector interface, adapter code breaks.
**Value:** High. Replaces ~500 lines of custom CrossFilterManager + query optimization code with battle-tested library. Adds materialized pre-aggregation we don't currently have.
**Recommendation:** **Prototype during implementation.** Write a connector proof-of-concept during Phase 3 (Dashboard). If it works well, adopt fully. If not, keep CrossFilterManager.

### 3.3 `vgplot` — DEFER

**What it provides:**
- Grammar of graphics where marks are Mosaic clients
- Uses Observable Plot as SVG renderer
- Marks auto-generate DuckDB queries (no manual SQL)
- Interactive selections: brush, pan/zoom, toggle, nearest
- M4 optimization: pixel-aware binning for time series (dramatic data reduction)
- Density marks: heatmap, contour, hexbin, denseLine
- Geographic marks via DuckDB `spatial` extension

**datspace alignment:**

| Feature | datspace Current | vgplot |
|---------|-------------------|--------|
| Statistical charts | Observable Plot + Arquero | vgplot marks (auto-query) |
| Time series optimization | LTTB downsampling in ECharts | M4 in vgplot (pixel-aware) |
| Brush interactions | Custom DOM event handlers | Built-in interactors |
| Dashboard charts (Sankey, gauge, treemap) | ECharts | **Not available** |
| Data grid | Perspective.js | **Not available** |

**Key limitation:** vgplot does NOT replace ECharts or Perspective. datspace needs all three visualization libraries. Adopting vgplot as a fourth library adds complexity without eliminating any existing dependency.

**M4 optimization:** The one compelling unique feature. M4 performs pixel-aware binning that preserves visual shape while drastically reducing rendered points for time series. Could be valuable for datspace's time series dashboards. However, this optimization can be extracted independently or replicated in ~50-100 lines of DuckDB SQL.

**Risk:** Medium. Adds a fourth visualization framework, requires Mosaic Coordinator.
**Value:** Low-medium. Observable Plot + Arquero already covers statistical charts. M4 is nice-to-have.
**Recommendation:** **Defer.** Revisit only if Observable Plot + Arquero proves insufficient for interactive chart needs, or if M4 optimization becomes critical.

### 3.4 `mosaic-spec` — DEFER

**What it provides:**
- Declarative JSON/YAML specification for complete dashboards
- Top-level properties: `meta`, `config`, `data`, `params`, `plotDefaults`, and component tree
- `parseSpec(json)` → AST
- `astToDOM(ast)` → live Mosaic-backed DOM elements
- `astToESM(ast)` → JavaScript ESM source code
- Supports vconcat/hconcat layout, data source definitions, cross-filtering via selections

**Example:**
```yaml
data:
  events: { file: data/events.parquet }
params:
  brush: { select: crossfilter }
plot:
  - mark: dot
    data: { from: events }
    x: timestamp
    y: value
    filterBy: $brush
```

**datspace alignment:** Could power Phase 5 (Publishing) dashboard serialization. Save user's dashboard layout, chart configs, filter state as JSON → reload later. Also enables "dashboard templates" — pre-built analytical views users can apply to their data.

**Risk:** Low (additive, doesn't replace anything).
**Value:** Medium, but not needed until Phase 5.
**Recommendation:** **Defer to Phase 5.** Evaluate when designing the Publishing Engine.

### 3.5 `mosaic-inputs` — SKIP

**What it provides:** Data-driven menu, search, slider, table widgets connected to Mosaic Selections.

**datspace alignment:** React already provides form components. Dexie.js reactive queries power UI state. Value only with full Mosaic Coordinator adoption.

**Recommendation:** **Skip.** React ecosystem is sufficient.

## 4. Custom Electron Connector Analysis

### Interface Requirements

A Mosaic connector must implement:
```typescript
interface MosaicConnector {
  query(sql: string): Promise<ArrowTable | object[]>;
  // Optional: Arrow-specific method
  arrowBuffer?(sql: string): Promise<ArrayBuffer>;
}
```

### datspace Worker Thread Bridge

```typescript
class ElectronDuckDBConnector {
  private port: MessagePort; // to DuckDB Worker Thread

  constructor(port: MessagePort) {
    this.port = port;
  }

  async query(sql: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const handler = (event: MessageEvent) => {
        if (event.data.id === id) {
          this.port.removeEventListener('message', handler);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.arrowBuffer); // Arrow IPC ArrayBuffer
        }
      };
      this.port.addEventListener('message', handler);
      this.port.postMessage({ id, type: 'query', sql });
    });
  }
}

// Usage:
const connector = new ElectronDuckDBConnector(duckdbPort);
const coordinator = new Coordinator(connector);
```

**Complexity assessment:** ~50-80 lines for the basic connector. Additional work for:
- Query cancellation support (~30 lines)
- Connection lifecycle management (~20 lines)
- Error mapping (Mosaic error types ↔ DuckDB errors, ~30 lines)
- Total: ~130-160 lines

This is significantly less complex than our current CrossFilterManager (~500 lines with debouncing, predicate management, and event propagation).

## 5. Architecture Comparison

### Current datspace (designed)

```
┌─────────────┐    MessagePort     ┌────────────┐
│  Renderer   │◄──────────────────▶│  DuckDB    │
│             │    Arrow IPC       │  Worker    │
│ ┌─────────┐ │                    └────────────┘
│ │CrossFilt│ │    Custom SQL
│ │Manager  │ │    string building
│ └────┬────┘ │    Manual debounce
│      │      │    Manual caching
│ ┌────┴────┐ │
│ │Plot/EC/ │ │
│ │Perspect │ │
│ └─────────┘ │
└─────────────┘
```

### With Mosaic Core + SQL (potential)

```
┌─────────────┐    MessagePort     ┌────────────┐
│  Renderer   │◄──────────────────▶│  DuckDB    │
│             │    Arrow IPC       │  Worker    │
│ ┌─────────┐ │                    └────────────┘
│ │Mosaic   │ │    mosaic-sql
│ │Coordin. │ │    Query builder
│ │+Select. │ │    Auto-optimize
│ └────┬────┘ │    Built-in cache
│      │      │    Pre-aggregation
│ ┌────┴────┐ │
│ │Mosaic   │ │
│ │Clients  │ │
│ │(custom) │ │
│ └─────────┘ │
└─────────────┘
```

### What Mosaic adds:
- **Query optimization:** Coordinator consolidates duplicate queries, creates materialized pre-aggregation views
- **Built-in caching:** Result cache with smart invalidation
- **Cross-filter math:** `crossfilter` resolution excludes originating client from its own filter (the correct cross-filter behavior) — our CrossFilterManager implements this manually
- **Composable SQL:** mosaic-sql Query class vs hand-written strings

### What Mosaic does NOT replace:
- **Arrow IPC protocol:** Our MessagePort + Arrow IPC channels remain
- **DuckDB hosting:** Worker Thread architecture unchanged
- **LanceDB integration:** Mosaic knows nothing about vector search
- **Perspective.js:** Needs custom Mosaic client wrapper
- **ECharts:** Needs custom Mosaic client wrapper
- **Dexie.js:** Reactive UI state is a different layer
- **AI integration:** Separate concern entirely

## 6. Bundle Size Impact

| Package | Estimated Size | Notes |
|---------|---------------|-------|
| `mosaic-sql` | ~30-50 KB | Pure JS, no dependencies |
| `mosaic-core` | ~50-80 KB | Coordinator, Selections, Params |
| `vgplot` | ~100-150 KB | Requires mosaic-core + mosaic-plot |
| `mosaic-spec` | ~40-60 KB | Parser + generators |
| **If adopting sql only** | **~30-50 KB** | **Negligible on ~260-340 MB** |
| **If adopting core + sql** | **~80-130 KB** | **Still negligible** |

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Pre-1.0 breaking API changes | Medium | Medium | Pin version, adapter layer isolates changes |
| Custom connector doesn't work with Worker Threads | Low | High | Prototype early in Phase 3; fallback to CrossFilterManager |
| Mosaic Coordinator overhead for simple queries | Low | Low | Bypass coordinator for direct queries; use only for dashboard views |
| vgplot adoption locks us into Mosaic stack | Medium | Medium | Don't adopt vgplot; use mosaic-sql and mosaic-core independently |
| Mosaic abandoned by UW IDL | Low | Medium | Active research project (28 releases, TVCG publication); same team maintains Arquero/Plot |

## 8. Recommendation

### Immediate (System Design Phase)

| Package | Decision | Action |
|---------|----------|--------|
| `mosaic-sql` | **Adopt** | Note in system design as the SQL construction layer. No design revisions needed — this is an implementation detail that doesn't affect architecture. |
| `mosaic-core` | **Evaluate** | Document as a candidate for CrossFilterManager replacement. Note feasibility of custom connector. Defer commitment to implementation phase. |
| `vgplot` | **Defer** | Do not include in design. Observable Plot + Arquero is the chosen stack. |
| `mosaic-spec` | **Defer** | Revisit during Phase 5 (Publishing Engine) design. |
| `mosaic-inputs` | **Skip** | React ecosystem sufficient. |

### Implementation Phase Milestones

1. **Phase 1-2 (Core + Data):** Adopt `mosaic-sql` for all DuckDB query construction
2. **Phase 3 (Dashboard):** Prototype Mosaic Coordinator with custom Electron connector
   - If prototype succeeds → adopt mosaic-core, replace CrossFilterManager
   - If prototype fails → keep CrossFilterManager, still use mosaic-sql
3. **Phase 5 (Publishing):** Evaluate `mosaic-spec` for dashboard serialization

### Design Document Impact

**No design revisions required now.** Rationale:
- `mosaic-sql` is an implementation-level choice (how SQL strings are built), not an architectural decision
- `mosaic-core` adoption is conditional on implementation-phase prototyping
- The current CrossFilterManager design in 08-visualization-engine.md is the correct fallback

**If mosaic-core is adopted later (R5+ revision):**
- 08-visualization-engine.md: Replace Section 5.3 CrossFilterManager with Coordinator + Selections
- 02-electron-process-model.md: Add custom connector to process architecture
- ADR-003: Amend with Mosaic core adoption decision
- 01-system-overview.md: Add to technology table

---

**Conclusion:** Mosaic is a compelling framework from a trusted team (UW IDL). `mosaic-sql` is a clear win with zero risk. `mosaic-core` has high potential but needs implementation-phase validation for the Electron/Worker Thread architecture. vgplot and mosaic-spec are valuable but unnecessary given our current Observable Plot + Arquero + ECharts stack. The correct strategy is incremental adoption: sql now, core prototype later, spec much later.
