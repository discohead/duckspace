# Arquero Integration Research

**Date:** 2026-02-05
**Purpose:** Evaluate Arquero for duckspace Renderer-side data wrangling layer
**Sources:** idl.uw.edu/arquero, github.com/uwdata/arquero, Observable Plot PR #2115, idl.uw.edu/flechette

---

## 1. Library Overview

**Arquero** is a JavaScript library for query processing and transformation of array-backed data tables, following relational algebra principles. Developed by UW Interactive Data Lab (same team as Observable Plot, D3, Vega).

- **Version:** 8.0.3 (May 2025)
- **License:** BSD-3-Clause
- **Bundle size:** ~150KB ES module (Flechette Arrow support included)
- **Dependencies:** Minimal; uses Flechette for Arrow processing (bundled)
- **Performance claim:** "Process data tables with million+ rows"

## 2. Arrow Integration

### fromArrow()

Loads Apache Arrow tables with zero-copy semantics for many data types:

> "For many data types, Arquero uses binary-encoded Arrow columns as-is with zero data copying."

**Exceptions to zero-copy:**
- Dictionary columns with null entries: unpacked for query performance
- Dictionary columns spanning multiple record batches: unpacked

**Input:** Accepts Arrow IPC buffers or Apache Arrow Table objects.

### Flechette (Internal Arrow Engine)

Arquero v8 uses **Flechette** instead of the Apache Arrow JS reference implementation:
- ~43KB minified (14KB gzipped) vs ~163KB for Arrow JS
- 2-7x faster array extraction than Arrow JS
- 7-11x faster row object extraction
- Reads Arrow binary IPC format directly
- Tree-shakeable encoders/decoders
- Zero-copy access to binary data where data types allow
- `toColumns()` returns TypedArrays (Int16Array, Float32Array, etc.)

### toArrow()

Exports Arquero tables back to Arrow IPC format. Built into Arquero since v2.3 (formerly separate `arquero-arrow` package, now archived).

## 3. Key API Surface

### Table Creation
```javascript
import { fromArrow, table, from } from 'arquero';

// From Arrow IPC buffer (zero-copy where possible)
const dt = fromArrow(arrowIPCBuffer);

// From Apache Arrow Table object (zero-copy wrapping)
const dt = fromArrow(apacheArrowTable);

// From column arrays
const dt = table({ x: [1,2,3], y: ['a','b','c'] });
```

### Transformation Verbs
```javascript
dt.filter(d => d.value > 100)          // Row filtering
dt.derive({ pct: d => d.value / d.total }) // Computed columns
dt.select('col1', 'col2')              // Column selection
dt.orderby('col1')                     // Sorting
dt.groupby('category').rollup({ sum: d => op.sum(d.value) }) // Aggregation
dt.pivot('key', 'value')               // Reshape wide
dt.fold(['col1','col2'])               // Reshape long (unpivot)
dt.join(other, ['key'])                // Table join
dt.dedupe('id')                        // Remove duplicates
dt.sample(100)                         // Random sampling
```

### Output Methods
```javascript
dt.objects()          // Array of plain objects [{col1: v, col2: v}, ...]
dt.object(0)          // Single row as object
dt.column('name')     // Column accessor
dt.column('name').data // Underlying TypedArray (zero-copy for numeric)
dt.columnArray('name') // Column as JS array
dt.columnNames()      // Array of column name strings
dt.numRows()          // Row count
dt.numCols()          // Column count
dt.toArrow()          // Export back to Arrow IPC
```

### TypedArray Access
For numeric columns loaded from Arrow, `dt.column('name').data` returns the underlying TypedArray directly (Float32Array, Int32Array, etc.) without copying. This enables zero-copy passthrough to rendering libraries that accept TypedArrays.

## 4. Observable Plot Integration

### Plot PR #2115 (merged August 2024)

Observable Plot gained **native Apache Arrow Table support**:
- Detects Arrow Tables via `isArrowTable()` check
- Defers reading values until actually requested (lazy materialization)
- Uses `table.getChild()` and `vector.toArray()` internally
- All marks and transforms work with Arrow Tables

### Arquero Table Consumption by Plot

Observable Plot can consume data from Arquero through multiple paths:

1. **Direct iteration**: Plot iterates Arquero tables as array-like objects (Arquero tables support Symbol.iterator)
2. **Arrow Table passthrough**: If the Arquero table wraps Arrow data, the underlying Arrow Table can be extracted and passed to Plot's native Arrow path
3. **objects() conversion**: `dt.objects()` produces the array-of-objects format Plot natively accepts

**Recommended path for duckspace:** Use Arquero `fromArrow()` for wrangling, then pass directly to Plot marks. Plot's iterator protocol handles Arquero tables.

## 5. ECharts Integration Patterns

ECharts expects data in `dataset.source` format. Arquero provides three output methods:

### Array of Objects (Default ECharts mapping)
```javascript
const dt = fromArrow(arrowTable);
const prepared = dt.filter(d => d.active).derive({ rate: d => d.count / d.total });

// ECharts dataset.source as array of objects
option.dataset = { source: prepared.objects() };
```

### TypedArray Passthrough (Large numeric series)
```javascript
// Zero-copy: underlying TypedArray for ECharts series.data
const xData = dt.column('timestamp').data; // Float64Array
const yData = dt.column('value').data;     // Float64Array

option.xAxis = { data: xData };
option.series = [{ data: yData }];
```

### 2D Array (Memory-efficient for medium datasets)
```javascript
const header = dt.columnNames();
const rows = [...dt]; // Iterate rows
const tableData = [header, ...rows.map(r => header.map(c => r[c]))];
```

## 6. duckspace Architecture Fit

### Where Arquero Sits

```
[Worker Threads: DuckDB/LanceDB]
        |
   Arrow IPC via MessagePort (zero-copy transfer)
        |
[Renderer Process]
        |
   tableFromIPC() → Apache Arrow Table
        |
   ArrowResultCache (LRU, 256MB)
        |
        +---> Perspective.js: table.update(arrowBuffer) [unchanged, no Arquero]
        |
        +---> Arquero: fromArrow(arrowTable) [zero-copy wrapping]
                |
                +---> Observable Plot: pass Arquero table directly to marks
                |
                +---> ECharts: dt.objects() or dt.column().data (TypedArray)
```

### What Arquero Replaces
- `arrowToPlotData()` utility (~30 lines of manual toArray() conversion)
- `arrowToColumnArrays()` utility (~20 lines)
- `arrowToEChartsDataset()` utility (~25 lines)
- Manual column iteration and null handling

### What Arquero Adds
- Client-side wrangling on pre-aggregated subsets (filter, derive, rollup)
- Computed columns without re-querying DuckDB
- Field restructuring for visualization-specific formats
- Cross-filter predicate building on cached data
- TypedArray passthrough for ECharts large series (millions of points)

### What Stays in DuckDB
- Heavy aggregation (GROUP BY, window functions, time_bucket)
- Large-scale filtering (millions of rows)
- Cross-database joins (DuckDB + LanceDB via Lance extension)
- Any operation on datasets > 10K rows

## 7. Bundle Impact

| Component | Current | With Arquero |
|-----------|---------|-------------|
| apache-arrow JS | ~500 KB | ~500 KB (retained for Perspective + IPC deserialization) |
| Arquero | -- | ~150 KB (includes Flechette) |
| Custom adapters | ~75 lines | Removed (replaced by Arquero) |
| **Net change** | -- | **+150 KB, -75 lines custom code** |

**Future optimization:** Flechette (~43KB) could replace apache-arrow JS (~500KB) for IPC deserialization, since Perspective accepts raw IPC buffers directly. This would save ~350KB but requires validating Flechette compatibility with all Arrow IPC features used by DuckDB/LanceDB. Deferred to implementation phase.

## 8. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| fromArrow() doesn't zero-copy with DuckDB's Arrow output | Low | DuckDB outputs standard Arrow IPC; Flechette reads standard IPC |
| Observable Plot doesn't iterate Arquero tables correctly | Low | Both are UW IDL projects; Plot's array protocol handles table iteration |
| Flechette incompatible with Arrow IPC v5 features | Low | Flechette actively maintained by same team; targets IPC standard |
| Bundle size exceeds budget | Negligible | +150KB on ~260-340MB total is <0.1% |

## 9. Conclusion

Arquero is the correct choice for duckspace's Renderer-side data wrangling:
- **Zero-copy Arrow loading** via `fromArrow()` maintains the Constitution's Arrow-First principle
- **Native Plot integration** eliminates the `toArray()` conversion step
- **TypedArray passthrough** for ECharts enables zero-copy rendering of large numeric series
- **Client-side wrangling** fills the gap between DuckDB aggregation and visualization consumption
- **Same team** (UW IDL) as Observable Plot and Flechette ensures long-term compatibility
- **BSD-3-Clause license** is compatible with project requirements
