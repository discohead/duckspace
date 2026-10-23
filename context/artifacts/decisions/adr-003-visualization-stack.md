# ADR-003: Visualization Technology Stack

**Status:** Accepted
**Date:** 2026-02-04
**Deciders:** duckspace Architecture Team
**Domain:** System Design -- duckspace

---

## Context

duckspace is an Electron-based desktop analytics application that must render diverse visualization types across three distinct usage patterns, each with fundamentally different technical requirements:

1. **High-performance tabular display.** Users need to explore raw datasets of millions of rows through data grids, pivot tables, and cross-tabulations. This demands virtual scrolling, server-side query pushdown, and native Apache Arrow ingestion to avoid materializing full datasets into JavaScript memory. The application's "stream-and-scan" principle (Constitution constraint #11) prohibits bulk-loading data into the renderer.

2. **Statistical and explanatory visualization.** Analysts need distribution charts (box plots, density plots), regression visualizations, confidence intervals, small multiples, and publication-quality annotated charts. These operate on pre-aggregated subsets (typically <10K rows) and prioritize visual clarity, annotation support, and concise developer API over raw rendering throughput.

3. **Interactive dashboard components.** Dashboards require time series charts with zoom and brush selection, KPI gauges, geographic maps, Sankey/chord diagrams, and funnel charts. These demand progressive rendering for large series, built-in downsampling algorithms (e.g., LTTB), and Canvas/WebGL rendering for smooth interaction.

No single visualization library adequately covers all three patterns. Data grids require WASM-based columnar engines with Arrow support. Statistical charts require a high-level declarative API producing SVG. Dashboard widgets require an interactive charting library with progressive rendering and WebGL support. Attempting to force one library into all three roles results in either poor performance, excessive development complexity, or both.

Additionally, the project's architectural constraints require:

- **Arrow-first data flow** (Constitution #9): All inter-component data transfer uses Apache Arrow IPC. JSON serialization in hot paths is prohibited.
- **Embedded-only databases** (Constitution #10): DuckDB runs in-process in Electron's main process.
- **Process isolation** (Constitution #12): Main process owns database engines; renderer process owns visualization.
- **macOS-first** (Constitution #13): All technologies must work on macOS with Electron's Chromium runtime.

These constraints narrow the viable technology choices significantly, ruling out libraries that require JSON/array-only input or depend on external server processes.

---

## Decision

duckspace adopts a three-library visualization stack, unified by Apache Arrow as the interchange format. Each library is assigned a specific, non-overlapping role.

### Primary Stack

| Component | Technology | Version | License | Role |
|-----------|-----------|---------|---------|------|
| Data Grid / Pivot Table | **Perspective.js** | >= 3.x | Apache 2.0 | Interactive exploration of raw data, pivot tables, cross-tabulations |
| Statistical Charts | **Observable Plot** | >= 0.6 | ISC | Distributions, regressions, small multiples, annotated explanatory charts |
| Dashboard Charts | **ECharts** | >= 5.5 | Apache 2.0 | Time series, KPI gauges, geographic maps, relationship diagrams |
| Data Interchange | **Apache Arrow JS** | >= 17.x | Apache 2.0 | Universal data format between DuckDB and all visualization components |

### Perspective.js: Data Grid and Pivot Engine

Perspective.js serves as the primary data exploration tool. Key architectural decisions:

- **DuckDBHandler pattern.** Rather than loading data into Perspective's internal WASM table, a DuckDBHandler sends SQL queries to DuckDB (running in Electron's main process) and receives Arrow IPC results. Perspective renders directly from the Arrow buffer. Filter, sort, and aggregation operations are pushed down to DuckDB as SQL queries.
- **Virtual scrolling with query pushdown.** Scrolling through datasets of 100M+ rows fetches only the visible rows (~50-100 at a time) via paginated DuckDB queries. No bulk data loading occurs.
- **WASM engine in Web Worker.** Perspective's C++ engine compiled to WebAssembly runs in a Web Worker, keeping the renderer's UI thread free for 60fps interaction.
- **Native Arrow IPC input.** `table.update(arrowBuffer)` accepts Arrow IPC directly. Arrow maps into WASM memory with minimal copying, and schema/type information is preserved from DuckDB through to visualization.
- **WebGL datagrid rendering.** The datagrid plugin uses WebGL for cell rendering. On macOS, Chromium maps WebGL to Metal for native GPU performance.

**Bundle size:** ~8MB WASM + ~2MB JS. Acceptable for a desktop application.

### Observable Plot: Statistical Visualization

Observable Plot handles all explanatory and statistical chart types:

- **Declarative marks API.** Charts are specified in 5-20 lines of JavaScript. The functional API (`Plot.plot({marks: [...]})`) returns SVG elements directly, integrating naturally with the renderer's DOM.
- **Pre-aggregated data input.** Observable Plot receives small Arrow results (pre-aggregated by DuckDB), loaded into Arquero tables via `fromArrow()` (zero-copy), then consumed directly by Observable Plot marks via iterator protocol. Only aggregated subsets (<10K rows) ever materialize as JavaScript objects.
- **SVG by default, Canvas for density.** SVG output provides crisp rendering at any resolution and supports CSS styling. Canvas marks are used only for scatter plots exceeding 10K points.
- **Arquero data wrangling.** Arquero serves as the data wrangling layer between Arrow IPC deserialization and Observable Plot consumption. `fromArrow()` provides zero-copy Arrow table loading via Flechette. Observable Plot iterates Arquero tables directly via iterator protocol — no explicit `toArray()` conversion needed. Lightweight client-side operations (filter, derive, rollup) are performed in Arquero on pre-aggregated subsets. Bundle cost: ~150KB (BSD-3-Clause).

**Bundle size:** ~150KB ES module.

### ECharts: Interactive Dashboard Widgets

ECharts powers interactive dashboard components:

- **Built-in downsampling.** The `sampling` option supports LTTB (Largest Triangle Three Buckets), which preserves visual shape while reducing rendered points. This is critical for time series with millions of data points.
- **Progressive rendering.** Charts with >100K points render incrementally via `progressive` and `progressiveThreshold` options, avoiding frame drops.
- **WebGL renderer.** The `echarts-gl` extension provides WebGL scatter and line rendering for million-point datasets, mapping to Metal on macOS.
- **Tree-shakeable imports.** Only the chart types actually used are bundled, reducing the effective bundle size from ~1MB to ~300KB.
- **Arrow adapter.** Arquero `fromArrow()` loads Arrow data zero-copy; `dt.objects()` provides array-of-objects for ECharts `dataset.source`, and `dt.column().data` provides TypedArray passthrough for large numeric series (zero-copy). DuckDB performs all heavy aggregation (e.g., time-bucket grouping) before transfer.

**Bundle size:** ~300KB tree-shaken + ~200KB for echarts-gl.

### Dashboard Composition

All three libraries coexist in a single Electron renderer window:

- **Layout:** CSS Grid with ResizeObserver. Each visualization component occupies a grid cell and re-renders on resize. Optional drag-and-drop rearrangement via `react-grid-layout`.
- **Cross-filter coordination:** A lightweight Filter Manager (custom event emitter) maintains SQL WHERE clause predicates. When a user interacts with any chart (e.g., clicking a bar in ECharts), the Filter Manager propagates the predicate to all components, which re-query DuckDB with updated filters. Events are debounced at 100-200ms.
- **Single window architecture.** All visualization components share one renderer process. This simplifies cross-filter state management, avoids duplicate WASM instances, and is sufficient for modern macOS GPU performance with multiple WebGL contexts.

### Arrow Data Flow

The end-to-end data path enforces Arrow-first principles:

```
[Data Source] (File / Remote API)
      |
      v
[Main Process: DuckDB]
  - Columnar storage, SQL query execution
  - Returns Arrow IPC buffers
      |
      v
[IPC: MessagePort + SharedArrayBuffer]
  - Zero-copy transfer where possible
      |
      v
[Renderer Process]
  |
  +---> Perspective.js (Arrow IPC -> WASM memory -> WebGL render)
  |       No JS memory materialization for grid data
  |
  +---> Observable Plot (small Arrow -> Arquero fromArrow -> native iteration -> SVG render)
  |       Only pre-aggregated subsets convert to JS
  |
  +---> ECharts (small Arrow -> Arquero -> objects/TypedArray -> Canvas/WebGL render)
          Only pre-aggregated subsets convert to JS
```

Raw data never materializes as JavaScript objects in the renderer. Only pre-aggregated summaries (typically <10K rows) are loaded into Arquero via `fromArrow()` for Observable Plot (zero-copy iteration) and ECharts (`dt.objects()` or TypedArray passthrough). Perspective handles raw data natively via Arrow + WASM.

---

## Alternatives

### Data Grid Alternatives

#### AG Grid

AG Grid is the most popular web data grid but lacks critical capabilities for duckspace:

- **No Arrow support.** Accepts only JSON or JavaScript arrays, requiring full deserialization of data into JS heap memory. This violates the Arrow-first (Constitution #9) and stream-and-scan (#11) principles.
- **WASM engine absent.** Pure JavaScript execution creates GC pressure on large datasets. Perspective's C++ WASM engine avoids garbage collection entirely for data operations.
- **Commercial pivot license.** Pivot table and aggregation features require AG Grid Enterprise, a paid commercial license. Perspective provides these features under Apache 2.0.
- **No query pushdown.** AG Grid assumes client-side data. Virtual scrolling fetches from an in-memory store, not from a database query. Integrating DuckDB pushdown would require custom development that Perspective provides natively via the DuckDBHandler pattern.

**Verdict:** Rejected. Fundamental mismatch with Arrow-first architecture and stream-and-scan requirements.

#### Tabulator

Tabulator is lightweight and highly customizable but fundamentally JS-only:

- **No Arrow support.** Requires data as JavaScript arrays.
- **Client-side only.** Virtual scrolling operates on in-memory data, with no server-side/database pushdown mechanism.
- **Limited pivot capabilities.** Group-by and pivot features are basic compared to Perspective's full pivot table engine.

**Verdict:** Rejected. Would require loading datasets into JS memory, violating Constitution #11.

#### Handsontable

Handsontable focuses on spreadsheet-like editing rather than analytical exploration:

- **Edit-oriented.** Designed for data entry, not data analysis. Lacks pivot tables, advanced filtering, and analytical grouping.
- **Commercial license.** Free version is limited; full features require commercial license.
- **No Arrow or WASM support.**

**Verdict:** Rejected. Wrong tool for analytical data exploration.

### Statistical Chart Alternatives

#### D3.js (Direct)

D3.js is the foundational visualization library but operates at too low a level:

- **Low-level API.** Building a box plot in D3 requires 50-100 lines of bindall primitives. Observable Plot achieves the same in 5-10 lines.
- **High maintenance cost.** More code means more maintenance. For a system design project with many chart types, D3's verbosity is a productivity drain.
- **Observable Plot is built on D3.** Plot uses D3 internally, so D3 primitives remain available as an escape hatch for custom visualizations.

**Verdict:** Rejected as primary. Available as escape hatch through Observable Plot's D3 compatibility.

#### Vega-Lite

Vega-Lite provides a declarative JSON grammar for visualization:

- **JSON specification layer.** Charts are defined as JSON objects, requiring a parsing/compilation step before rendering. This adds complexity compared to Observable Plot's direct JavaScript API.
- **Larger runtime.** Requires the Vega runtime (~500KB) plus the Vega-Lite compiler.
- **Indirect Electron integration.** JSON specs must be compiled to Vega specs, then rendered. Observable Plot generates DOM elements directly from JavaScript, a more natural fit for Electron's renderer.
- **Rich interaction grammar.** Vega-Lite's selection and interaction grammar is more powerful than Observable Plot's. However, duckspace delegates complex interactions (cross-filtering, brushing) to the dashboard Filter Manager rather than encoding them in chart specs.

**Verdict:** Rejected. JSON grammar adds unnecessary indirection in an Electron renderer context.

#### Plotly (for statistical charts)

Plotly.js includes statistical chart types but has significant overhead:

- **Monolithic bundle.** ~3.5MB for the full library, versus Observable Plot's ~150KB.
- **Slow initialization.** Heavy startup cost per chart instance.
- **Dual-purpose overlap.** Using Plotly for statistical charts would overlap with its dashboard chart capabilities, creating ambiguity about which library to use for which purpose.

**Verdict:** Rejected. Bundle size and initialization cost are excessive for the statistical chart role.

### Dashboard Chart Alternatives

#### Plotly.js

Plotly.js is the most feature-rich charting library but carries significant weight:

- **Bundle size.** ~3.5MB full bundle versus ECharts' ~300KB tree-shaken. For a desktop app that already includes ~10MB for Perspective, adding 3.5MB for Plotly is disproportionate.
- **No built-in downsampling.** LTTB and other downsampling algorithms must be implemented externally. ECharts includes them natively.
- **Slower progressive rendering.** Plotly does not natively support progressive rendering for large datasets. ECharts' `progressive` option is built-in.

**Verdict:** Rejected. Larger bundle, missing built-in downsampling, and slower for large datasets.

#### Highcharts

Highcharts is mature and feature-rich but commercially licensed:

- **Commercial license required.** Free only for personal/non-commercial use. This conflicts with the project's preference for Apache 2.0 / MIT licensed components.
- **WebGL via separate module.** The Boost module provides WebGL rendering but is an add-on rather than integrated. ECharts' WebGL support is more tightly integrated.

**Verdict:** Rejected. Commercial license requirement.

#### Chart.js

Chart.js is lightweight and popular but lacks features for analytics dashboards:

- **Limited chart types.** Covers basic charts (bar, line, pie, scatter) but lacks Sankey diagrams, tree maps, geographic maps, and gauge charts that duckspace dashboards require.
- **No progressive rendering.** Cannot handle datasets beyond ~10K points without custom optimization.
- **No WebGL renderer.** Canvas-only, which limits maximum dataset size for smooth rendering.

**Verdict:** Rejected. Insufficient chart type coverage and no large-dataset optimization.

### Unified Single-Library Approach

The alternative of using one library (e.g., Plotly) for all visualization was considered:

- **Pro:** Single API, single bundle, simpler mental model, no cross-library coordination.
- **Con:** No single library excels at all three roles. Plotly lacks native Arrow input and WASM-powered data grids. AG Grid lacks charts entirely. ECharts lacks pivot tables and statistical marks.
- **Con:** A single library that tries to do everything results in mediocre performance across all use cases rather than excellent performance in each.
- **Con:** The cross-filter coordination complexity exists regardless of library count -- it is inherent to multi-chart dashboards.

**Verdict:** Rejected. The specialization of three focused libraries outperforms any single generalist library across the three distinct visualization patterns.

---

## Consequences

### Positive

1. **Arrow-native data grid.** Perspective.js is the only major data grid with first-class Arrow IPC input. This eliminates serialization overhead and aligns perfectly with the project's Arrow-first data flow, preserving type fidelity from DuckDB through to visualization.

2. **Stream-and-scan compliance.** The DuckDBHandler + virtual scrolling pattern ensures raw datasets never load into JavaScript memory. Observable Plot and ECharts receive only pre-aggregated subsets. This satisfies Constitution constraint #11 across the entire visualization layer.

3. **Full analytics coverage without redundancy.** Each library has a clearly defined, non-overlapping role: Perspective for data exploration, Observable Plot for statistical explanation, ECharts for interactive dashboards. There are no ambiguous "which library should I use" decisions.

4. **Open source licensing.** All three libraries are Apache 2.0 or ISC licensed. No commercial license risk or cost.

5. **GPU acceleration path.** Perspective uses WebGL for datagrid rendering, ECharts supports WebGL via echarts-gl, and both map to Metal on macOS. Future WebGPU adoption is architecturally compatible without stack changes.

6. **Acceptable combined bundle size.** ~12MB total (Perspective ~10MB, ECharts ~500KB, Observable Plot ~150KB) is well within desktop application norms where Electron apps typically ship at 100MB+.

### Negative

1. **Multiple library bundle size.** Three visualization libraries plus Apache Arrow JS add ~12MB to the application bundle. While acceptable for desktop, this is larger than a single-library approach. Mitigation: tree-shake ECharts imports to include only used chart types; lazy-load Observable Plot and ECharts on first use.

2. **Cross-filter coordination complexity.** Propagating filter state across three different libraries requires a custom Filter Manager with library-specific adapters. Each library has a different event model (Perspective custom events, ECharts event handlers, Observable Plot DOM events) that must be unified. Mitigation: the Filter Manager abstracts these differences behind a common `onFilterChange`/`emitFilter` protocol, and all filtering pushes down to DuckDB SQL predicates regardless of source.

3. **Arrow format compatibility burden.** Arrow IPC must be consumable by all three libraries. Perspective accepts Arrow natively. Observable Plot and ECharts use Arquero's fromArrow() for zero-copy Arrow loading, replacing the manual toArray() adapter (~75 lines) with a single library dependency. Arquero (UW IDL, BSD-3-Clause) provides a stable API and is maintained by the same team as Observable Plot, reducing long-term maintenance risk.

4. **Different rendering approaches.** Perspective renders via WebGL, Observable Plot via SVG (default), and ECharts via Canvas/WebGL. This means three different rendering pipelines coexist in one renderer process, competing for GPU contexts and requiring different resize/repaint strategies. Mitigation: ResizeObserver handles per-component resize; a single renderer window manages GPU context sharing efficiently on modern macOS.

5. **Developer learning curve.** Contributors must understand three visualization APIs rather than one. Each library has its own configuration paradigm (Perspective: custom element attributes, Observable Plot: functional marks API, ECharts: declarative options object). Mitigation: provide wrapper components that expose a consistent duckspace API, abstracting library-specific configuration.

6. **Perspective WASM memory limits.** Perspective's WASM linear memory (default ~256MB) can be exhausted by very large pivot operations. Mitigation: use DuckDB-side aggregation for large pivots; configure Perspective to fetch on-demand via DuckDBHandler rather than pre-loading into WASM memory.

### Operational

- **Version management.** Three libraries must be kept up to date independently. Pin versions and test upgrades as a group to avoid compatibility regressions.
- **Testing strategy.** Each visualization component needs its own test approach: Perspective integration tests with DuckDB mock, Observable Plot snapshot tests for SVG output, ECharts snapshot tests for canvas configuration objects.
- **Performance monitoring.** Track renderer frame rate and memory usage across all three rendering pipelines. Set thresholds for degraded performance and implement fallback strategies (e.g., reduce visible data, disable animations).

---

*ADR-003 authored: 2026-02-04*
*Relates to: ADR-001 (Core Technology Stack), ADR-002 (Data Layer Architecture)*
*Informed by: Research finding -- Perspective.js and Visualization Stack in Electron*

---
**R4 Revision (2026-02-05):** Added Arquero integration to Observable Plot and ECharts data paths. Replaces manual toArray() adapter with Arquero fromArrow() (zero-copy). Added TypedArray passthrough for ECharts large series.
