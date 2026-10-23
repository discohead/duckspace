# Research Finding: Perspective.js and Visualization Stack in Electron

**Date:** 2026-02-04
**Domain:** System Design -- duckspace
**Scope:** Visualization technology evaluation for Electron-based desktop analytics

---

## Executive Summary

duckspace requires a visualization stack that operates entirely within the Electron renderer process, handles datasets of millions of rows without loading them fully into JavaScript memory, communicates via Apache Arrow, and composes multiple visualization types into interactive dashboards. After evaluating the ecosystem, the recommended stack is **Perspective.js** for data grids and exploratory analysis, **Observable Plot** for statistical and explanatory visualizations, and **ECharts** for interactive dashboard charts. This combination provides full coverage of analytics visualization needs while respecting the project's Arrow-first, stream-and-scan, and process-isolation principles.

---

## Perspective.js in Electron Renderer

### Architecture Overview

Perspective.js is a high-performance data visualization engine originally built by J.P. Morgan (now FINOS). Its architecture is uniquely suited to duckspace:

- **WebAssembly Core**: The data engine runs as a compiled C++ module via WebAssembly within the renderer process. This means data transformations (group-by, pivot, sort, filter) execute at near-native speed without leaving the browser context.
- **Web Worker Isolation**: By default, Perspective offloads its WASM engine to a Web Worker, keeping the UI thread free. In Electron, this translates to smooth 60fps interaction even during heavy pivots on large datasets.
- **Custom Element API**: The `<perspective-viewer>` custom element provides a self-contained, drop-in visualization component. It handles its own toolbar, column configuration, and chart type selection. This simplifies integration -- the renderer treats it as a standard DOM element.

### DuckDB as Data Backend

Perspective supports pluggable data backends. The critical integration point for duckspace:

- **DuckDBHandler Pattern**: Rather than loading data into Perspective's internal WASM table, the DuckDBHandler sends queries to DuckDB (running in the main process) and receives Arrow-formatted results. Perspective then renders directly from the Arrow buffer.
- **Query Pushdown**: Filter, sort, and aggregation operations translate to SQL queries pushed down to DuckDB. This is the "stream-and-scan" principle in action -- Perspective requests only the viewport-relevant data.
- **Virtual Scrolling**: Perspective's grid component uses virtual scrolling natively. Combined with DuckDB query pushdown, scrolling through 100M rows fetches only the visible rows (~50-100 at a time) via paginated queries.

### GPU Acceleration

- **WebGL Renderer**: Perspective's datagrid plugin uses WebGL for cell rendering, achieving smooth scrolling for large visible areas. Chart plugins (d3fc-based) also leverage Canvas/WebGL.
- **WebGPU Future**: Electron's Chromium base tracks WebGPU adoption. Perspective's rendering pipeline can evolve to use WebGPU for compute shaders (e.g., binning, histogram computation on GPU). This is not yet production-ready but is architecturally compatible.
- **macOS Metal Backend**: On macOS, Electron's Chromium maps WebGL/WebGPU calls to Metal, providing native GPU performance without additional configuration.

### Integration Considerations in Electron

| Aspect | Detail |
|--------|--------|
| Bundle Size | ~8MB WASM + ~2MB JS (acceptable for desktop app) |
| Memory Model | WASM linear memory is separate from JS heap; data stays in WASM land |
| CSP Compatibility | Requires `wasm-eval` in Content-Security-Policy; Electron allows this in renderer |
| Node Integration | Does not require Node integration in renderer; works with `contextIsolation: true` |
| Multiple Instances | Multiple `<perspective-viewer>` elements share a single WASM worker pool |

---

## Perspective.js + Apache Arrow Integration

### Native Arrow Support

Perspective has first-class Apache Arrow support -- this is its primary differentiator for duckspace:

- **Arrow IPC as Input**: `table.update(arrowBuffer)` accepts Arrow IPC format directly. No deserialization to JSON or JS objects.
- **Arrow as Internal Format**: Perspective's internal columnar representation is Arrow-compatible. When data arrives as Arrow, it maps directly into WASM memory with minimal copying.
- **Schema Inference**: Column types are inferred from Arrow schema metadata (int32, float64, utf8, timestamp, etc.), preserving type fidelity from DuckDB through to visualization.

### Streaming Updates

For duckspace's real-time connector scenarios (streaming from Mixpanel, PostHog, etc.):

- **RecordBatch Appending**: New Arrow RecordBatches can be appended via `table.update()` without reloading the full dataset. Perspective incrementally updates its indices.
- **Partial Updates**: Using a primary key column, `table.update()` can upsert rows -- matching rows are updated, new rows are inserted.
- **Remove Operations**: `table.remove()` by primary key enables streaming deletions.

### Memory Efficiency

The Arrow-Perspective pipeline avoids the typical web visualization memory bloat:

```
DuckDB (main process)
  -> Arrow IPC buffer (SharedArrayBuffer via MessagePort)
    -> Perspective WASM memory (zero-copy when possible)
      -> WebGL/Canvas render
```

- **Zero-Copy Path**: When Arrow data arrives via `SharedArrayBuffer`, Perspective can reference the memory directly in its WASM heap without copying.
- **Columnar Advantage**: Only columns needed for the current view are transferred. DuckDB's column projection pushdown ensures unused columns never leave the main process.
- **Memory Bounds**: Perspective's WASM memory is bounded (configurable, default ~256MB). When datasets exceed WASM memory, the DuckDBHandler pattern fetches on-demand rather than pre-loading.

---

## Observable Plot for Statistical Visualization

### Role in duckspace

Observable Plot fills the "explanatory and statistical" visualization niche that Perspective does not cover:

- **Statistical Charts**: Dot plots, box plots, density plots, regression lines, confidence intervals.
- **Faceted Views**: Small multiples / trellis charts for comparing distributions across categories.
- **Annotation-Rich**: Observable Plot excels at labeled, annotated charts for reports and publishing.

### Integration in Electron Renderer

- **Pure ES Module**: Observable Plot is a ~150KB ES module. It generates SVG (or optional Canvas) output directly in the DOM.
- **Data Input**: Accepts arrays of plain objects. For Arrow integration, a thin adapter converts Arrow columns to JS arrays for the visible/sampled subset.
- **Reactive Updates**: Observable Plot uses a functional API -- `Plot.plot({marks: [...]})` returns a new SVG element. In a React/Svelte wrapper, re-rendering is straightforward.

### When to Use Observable Plot vs. Perspective

| Scenario | Use |
|----------|-----|
| Explore raw data interactively (pivot, filter, sort) | Perspective |
| Data grid with millions of rows | Perspective |
| Statistical summary chart (box plot, density) | Observable Plot |
| Publication-quality annotated chart | Observable Plot |
| Small multiples / faceted comparison | Observable Plot |
| Real-time streaming data table | Perspective |
| Custom one-off analytical chart | Observable Plot |

### SVG vs. Canvas Trade-offs

- **SVG (default)**: Crisp at any resolution, accessible (DOM elements), supports CSS styling. Performant up to ~10,000 elements. Ideal for explanatory charts.
- **Canvas**: Better for scatter plots with >10K points. Observable Plot supports Canvas marks. duckspace should default to SVG and switch to Canvas only for dense scatter/point plots.

---

## ECharts for Interactive Dashboard Charts

### Role in duckspace

ECharts fills the "interactive dashboard" visualization niche:

- **Time Series**: Line, area, candlestick charts with zoom, brush selection, and data range selectors.
- **Geographic**: Map visualizations for location-based analytics data.
- **Relationship**: Sankey diagrams, chord diagrams, tree maps for flow/hierarchy analysis.
- **KPI Dashboards**: Gauge charts, radar charts, funnel charts for metric summaries.

### Large Dataset Handling

ECharts has specific features for performance with large datasets:

- **Downsampling**: Built-in `sampling` option ('lttb', 'average', 'max', 'min') for time series. LTTB (Largest Triangle Three Buckets) preserves visual shape while reducing points.
- **Progressive Rendering**: `progressive` and `progressiveThreshold` options render data incrementally. Charts with >100K points render progressively to avoid frame drops.
- **Dataset Component**: ECharts' `dataset` abstraction decouples data from chart configuration. duckspace can pipe Arrow-derived arrays into `dataset.source` without restructuring.
- **WebGL Renderer**: ECharts supports a WebGL renderer for scatter plots and lines with millions of points (`echarts-gl`). On macOS/Electron this maps to Metal.

### Arrow Integration Approach

ECharts does not natively consume Arrow. The integration pattern:

```
Arrow RecordBatch (from main process)
  -> arrow.toArray() for relevant columns (renderer)
    -> ECharts dataset.source = [{col1, col2, ...}, ...]
```

For large datasets, the adapter should:
1. Apply server-side (DuckDB) aggregation first -- e.g., time-bucket aggregation for time series.
2. Transfer only the aggregated result (~1K-10K rows) as Arrow to the renderer.
3. Convert the small aggregated Arrow to JS arrays for ECharts.

This respects the "stream-and-scan" principle: DuckDB does the heavy lifting, ECharts renders the summary.

### Bundle Size and Configuration

| Aspect | Detail |
|--------|--------|
| Full Bundle | ~1MB minified (tree-shakeable to ~300KB for specific chart types) |
| WebGL Extension | +200KB for echarts-gl |
| Theme System | Built-in dark/light themes; custom theme registration |
| Locale | i18n support for axis labels, tooltips |
| Renderer | SVG or Canvas selectable per chart instance |

---

## Dashboard Composition Architecture

### Component Coexistence Model

duckspace dashboards combine Perspective, Observable Plot, and ECharts in a single renderer window:

```
Renderer Process (Single BrowserWindow)
+-----------------------------------------------+
|  Dashboard Layout Manager (CSS Grid / Flexbox) |
|  +-------------------+  +-------------------+  |
|  | <perspective-      |  | ECharts Container |  |
|  |  viewer>           |  | (Canvas element)  |  |
|  | [Data Grid/Pivot]  |  | [Time Series]     |  |
|  +-------------------+  +-------------------+  |
|  +-------------------+  +-------------------+  |
|  | Observable Plot    |  | ECharts Container |  |
|  | (SVG element)      |  | (Canvas element)  |  |
|  | [Distribution]     |  | [KPI Gauge]       |  |
|  +-------------------+  +-------------------+  |
+-----------------------------------------------+
```

### Layout Management

**Recommended approach: CSS Grid with resize observers.**

- **CSS Grid**: Defines the dashboard grid. Each cell hosts one visualization component.
- **ResizeObserver**: Each visualization component listens for container resize and re-renders accordingly.
  - Perspective: `<perspective-viewer>` handles resize automatically via its internal ResizeObserver.
  - ECharts: Call `chart.resize()` on container resize.
  - Observable Plot: Re-call `Plot.plot()` with updated width/height dimensions.
- **Drag-and-Drop Rearrangement**: Libraries like `react-grid-layout` or `golden-layout` can manage user-customizable tile arrangements on top of CSS Grid.

### Cross-Filter Interactions

Cross-filtering enables clicking on one chart to filter all other charts. Architecture:

```
User clicks bar in ECharts chart
  -> Event: { filter: "region = 'West'" }
    -> Dashboard Filter Manager
      -> Update DuckDB query for all components
        -> Perspective: new DuckDBHandler query with WHERE clause
        -> Observable Plot: re-query DuckDB, re-render with filtered data
        -> ECharts: re-query DuckDB, update dataset
```

**Implementation pattern:**
1. **Filter Manager**: A lightweight event bus in the renderer that maintains the current filter state as a set of predicates.
2. **Predicate Format**: Filters expressed as Arrow-compatible predicates (or SQL WHERE clauses) that push down to DuckDB.
3. **Component Protocol**: Each visualization component implements:
   - `onFilterChange(predicates)`: Re-query and re-render with new filters.
   - `emitFilter(predicate)`: Publish a filter when user interacts.
4. **Debouncing**: Filter changes are debounced (100-200ms) to avoid excessive DuckDB queries during rapid interaction.

### Single vs. Multiple Renderer Windows

| Approach | Pros | Cons |
|----------|------|------|
| **Single Window** (recommended) | Simpler cross-filter, shared memory, single event bus | All visualizations compete for one GPU context |
| **Multiple Windows** | Independent GPU contexts, true parallelism | Complex cross-window IPC, no shared state, duplicate WASM instances |

**Recommendation**: Single renderer window. Modern macOS/Electron handles multiple WebGL contexts within one window efficiently. Multiple windows add IPC complexity that contradicts the "renderer owns visualization" principle. If GPU contention becomes an issue, use OffscreenCanvas in dedicated workers for specific chart types.

---

## Alternatives Considered

### Data Grid Alternatives

#### AG Grid

| Criterion | AG Grid | Perspective.js |
|-----------|---------|---------------|
| Arrow Support | None (JSON/array input only) | Native Arrow IPC input |
| Large Dataset Strategy | Virtual scrolling with client-side data | Virtual scrolling + server-side query pushdown |
| WASM Engine | No (pure JS) | Yes (C++ via WASM) |
| Pivot/Group-by | Enterprise license required ($) | Built-in, open source |
| Memory Model | JS heap (GC pressure on large data) | WASM linear memory (no GC) |
| Bundle Size | ~500KB (community) / ~2MB (enterprise) | ~10MB (WASM + JS) |
| License | Community: MIT; Enterprise: commercial | Apache 2.0 |

**Verdict**: AG Grid is excellent for traditional web apps but lacks Arrow integration and WASM performance. Its pivot features require a commercial license. Perspective's native Arrow support and WASM engine align with duckspace's architecture.

#### Tabulator

| Criterion | Tabulator | Perspective.js |
|-----------|-----------|---------------|
| Arrow Support | None | Native |
| Virtual Scrolling | Yes, but client-side only | Yes, with server-side pushdown |
| Computation | JS-only | WASM (C++) |
| Pivot/Group-by | Limited | Full pivot table |
| Extensibility | Highly customizable rendering | Plugin-based chart types |

**Verdict**: Tabulator is lightweight and flexible but fundamentally JS-only. It would require loading data into JS memory, violating the stream-and-scan principle for large datasets.

### Statistical Chart Alternatives

#### D3.js

| Criterion | D3.js | Observable Plot |
|-----------|-------|----------------|
| API Level | Low-level (bindall primitives) | High-level (declarative marks) |
| Learning Curve | Steep | Gentle |
| Customization | Unlimited | Extensive via marks/transforms |
| Code Volume | High (50-100 lines per chart) | Low (5-20 lines per chart) |
| Maintenance | More code to maintain | Concise, readable |

**Verdict**: Observable Plot is built on D3.js and provides a higher-level API. For duckspace, development velocity matters -- Plot achieves in 10 lines what D3 does in 50. Custom D3 is available as an escape hatch since Plot is D3-compatible.

#### Vega-Lite

| Criterion | Vega-Lite | Observable Plot |
|-----------|-----------|----------------|
| Specification | JSON grammar | JavaScript API |
| Runtime | Requires Vega runtime (~500KB) | Standalone (~150KB) |
| Interactivity | Rich selection/interaction grammar | Basic (events via DOM) |
| Output | Canvas or SVG | SVG or Canvas |
| Electron Fit | JSON spec requires parsing layer | Direct JS API, natural in renderer |

**Verdict**: Vega-Lite's declarative JSON grammar is powerful but adds a specification-parsing layer. Observable Plot's JS-native API integrates more naturally with Electron's renderer. For duckspace, the simpler stack wins.

### Interactive Chart Alternatives

#### Plotly.js

| Criterion | Plotly.js | ECharts |
|-----------|-----------|---------|
| Bundle Size | ~3.5MB (full) | ~1MB (full), ~300KB (tree-shaken) |
| Large Data | WebGL scatter up to ~1M points | WebGL scatter, progressive rendering, downsampling |
| Chart Types | ~50 types | ~30 types (covers all common analytics needs) |
| Customization | Moderate (layout-driven) | Extensive (option-driven) |
| Performance | Heavy initial load | Fast initial render, progressive for large data |
| Community | Large (Python/R ecosystem) | Massive (originated from Baidu) |

**Verdict**: Plotly.js is larger and slower to initialize. ECharts' tree-shakeable architecture and progressive rendering are better suited to a desktop app where bundle size and startup time matter. ECharts also has superior built-in downsampling (LTTB).

#### Highcharts

| Criterion | Highcharts | ECharts |
|-----------|------------|---------|
| License | Commercial (paid for commercial use) | Apache 2.0 |
| Large Data | Boost module for WebGL | Built-in WebGL renderer |
| Customization | Extensive | Extensive |

**Verdict**: Highcharts requires a commercial license. ECharts is Apache 2.0 and provides comparable functionality.

---

## Arrow Data Flow Through the Visualization Stack

End-to-end data flow respecting all architectural principles:

```
[Data Source] (File / Remote API)
      |
      v
[Main Process: DuckDB]
  - Stores data in columnar format
  - Executes SQL queries with predicate pushdown
  - Returns results as Arrow IPC buffers
      |
      v
[IPC Layer: MessagePort + SharedArrayBuffer]
  - Arrow IPC buffer transferred to renderer
  - Zero-copy via SharedArrayBuffer when possible
  - Transferable objects for one-time transfers
      |
      v
[Renderer Process: Visualization Components]
  |
  +---> Perspective.js
  |       - Receives Arrow IPC directly
  |       - Maps into WASM memory
  |       - Renders via WebGL datagrid
  |       - User interactions generate new DuckDB queries
  |
  +---> Observable Plot
  |       - Receives pre-aggregated Arrow (small)
  |       - Converts to JS arrays via toArray()
  |       - Renders SVG/Canvas
  |
  +---> ECharts
          - Receives pre-aggregated Arrow (small)
          - Converts to JS arrays via toArray()
          - Renders Canvas/WebGL
```

**Key invariant**: Raw data never materializes as JavaScript objects in the renderer. Only pre-aggregated summaries (typically <10K rows) convert to JS arrays for Observable Plot and ECharts. Perspective handles raw data natively via Arrow+WASM.

---

## Recommendation

### Primary Stack

| Component | Technology | Role |
|-----------|-----------|------|
| **Data Grid / Pivot Table** | Perspective.js | Interactive exploration of raw data, pivot tables, cross-tabulations. Direct Arrow input, WASM engine, virtual scrolling with DuckDB query pushdown. |
| **Statistical Charts** | Observable Plot | Explanatory and statistical visualizations: distributions, regressions, small multiples. SVG output for publication quality. |
| **Dashboard Charts** | ECharts | Interactive time series, KPI gauges, geographic maps, relationship diagrams. Canvas/WebGL rendering with progressive loading. |
| **Layout Manager** | CSS Grid + ResizeObserver | Dashboard composition with responsive panels. Optional: react-grid-layout for user-customizable layouts. |
| **Cross-Filter Bus** | Custom Event Emitter | Lightweight filter predicate propagation between visualization components. Predicates push down to DuckDB. |

### Integration Pattern

1. **Perspective** connects to DuckDB via a DuckDBHandler that issues SQL queries over the Electron IPC bridge. Arrow results flow directly into Perspective's WASM engine. No JS memory materialization for grid data.

2. **Observable Plot and ECharts** receive pre-aggregated data. The renderer issues aggregation queries to DuckDB (e.g., `SELECT region, AVG(revenue) FROM sales GROUP BY region`), receives small Arrow results, converts to JS arrays, and renders. This keeps JS heap usage minimal.

3. **Cross-filtering** is managed by a Filter Manager in the renderer that maintains SQL WHERE clause predicates. When a user interacts with any chart, the Filter Manager updates predicates and triggers re-queries for all components.

4. **Single renderer window** hosts all visualization components. This simplifies cross-filter coordination and avoids duplicate WASM instances.

### Why This Stack

- **Arrow-Native**: Perspective is the only major data grid with native Arrow input. This eliminates serialization overhead and aligns with the Arrow-first data flow principle.
- **Stream-and-Scan Compliant**: The DuckDBHandler + virtual scrolling pattern never loads full datasets into JS memory. Observable Plot and ECharts receive only aggregated subsets.
- **Process Isolation Respected**: All visualization runs in the renderer. DuckDB queries are issued over IPC to the main process. No database access in the renderer.
- **Open Source**: All three libraries are Apache 2.0 or MIT licensed. No commercial license risk.
- **Complementary Coverage**: Perspective excels at data exploration. Observable Plot excels at statistical/explanatory charts. ECharts excels at interactive dashboard components. Together they cover the full analytics visualization spectrum without redundancy.
- **Bundle Size Acceptable**: Combined ~12MB for a desktop application is well within acceptable limits (typical Electron apps ship 100MB+).

### Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Perspective WASM memory limits for very large pivots | Medium | Use DuckDB-side aggregation; limit Perspective's in-memory data to viewport + buffer |
| Observable Plot performance for >10K point scatter | Low | Switch to Canvas marks or delegate to ECharts scatter with WebGL |
| ECharts Arrow adapter maintenance | Low | Adapter is thin (~50 lines); Arrow-to-JS-array conversion is stable API |
| Cross-filter latency with complex queries | Medium | Debounce filter events; use DuckDB prepared statements; consider query caching |
| WebGPU API changes during Electron updates | Low | WebGPU is bonus optimization; WebGL fallback is stable and sufficient |

---

## Appendix: Technology Versions and Compatibility

| Technology | Recommended Version | Electron Compatibility |
|-----------|-------------------|----------------------|
| Perspective.js | >= 3.x | Chromium-based; full compatibility |
| Observable Plot | >= 0.6 | ES module; works in any modern browser context |
| ECharts | >= 5.5 | Works in Chromium; tree-shakeable imports |
| Apache Arrow JS | >= 17.x | Full compatibility; SharedArrayBuffer support in Electron |
| DuckDB WASM | >= 1.1 | Runs in main process (Node.js native) or worker |

---

*Research completed: 2026-02-04*
*Confidence: High -- all recommended technologies are mature, actively maintained, and verified compatible with Electron.*
