# Datspace

**A serverless data warehouse on your desktop.**

Datspace gives individual analysts the power of a modern data stack — SQL analytics, vector search, AI-assisted exploration, and interactive dashboards — without deploying servers, managing infrastructure, or paying per-query cloud costs. Everything runs locally on your Mac.

## Why Datspace?

Most analytics tools force you to choose: powerful but complex cloud platforms, or simple but limited desktop apps. Datspace combines the analytical depth of a cloud data warehouse with the simplicity of a native desktop application.

- **No servers to manage.** DuckDB runs embedded inside the app. Your data never leaves your machine.
- **No setup required.** Open a file, start querying. Parquet, CSV, JSON, and Excel files just work.
- **No per-query costs.** Analyze gigabytes of data using your own hardware at zero marginal cost.
- **No internet required.** Core analytics work fully offline. Remote connectors degrade gracefully.

## What You Can Do

### Query Anything with SQL

Write SQL against local files and get results instantly. DuckDB's vectorized columnar engine handles aggregations, joins, window functions, and more — the same query power as Snowflake or BigQuery, running on your laptop.

### Connect to Your Data Sources

Import local files (CSV, Parquet, JSON, Excel) or connect to remote sources:

- **Cloud storage** — Amazon S3, Google Cloud Storage (query Parquet files directly, no download needed)
- **Databases** — BigQuery, ClickHouse
- **SaaS platforms** — Mixpanel, PostHog, Google Sheets, Airtable

Remote data is cached locally so you can keep working when you go offline.

### Explore with AI

Ask questions about your data in plain English. Datspace integrates Claude AI to translate natural language into SQL, explain results, and generate visualizations — all grounded in your actual schema through built-in RAG retrieval. Embeddings run locally; your data stays private.

### Visualize and Share

Build interactive dashboards with drag-and-drop composition:

- **Data grids** with virtual scrolling, pivots, and filtering (Perspective.js)
- **Statistical charts** — histograms, scatter plots, regressions (Observable Plot)
- **Dashboard widgets** — time series, gauges, Sankey diagrams, maps (ECharts)
- **Cross-filtering** — click a chart element and every other panel updates

Export dashboards as self-contained HTML files you can share with anyone — no Datspace installation needed to view them.

### Browse Your Catalog

Every table and view is indexed in a searchable catalog with column types, row counts, and full-text search across schemas. Navigate your data the way you navigate files.

## System Requirements

- **macOS** (Apple Silicon or Intel)

## Installation

> Datspace is in active development. Pre-built binaries are not yet available.

To build from source:

```bash
git clone https://github.com/jaredmcfarland/datspace.git
cd datspace
npm install
npm run make
```

The installer will be generated in the `out/` directory.

For development:

```bash
npm install
npx electron-forge start
```

## How It Works

Datspace embeds three specialized database engines inside a native macOS app:

| Engine | Purpose |
|--------|---------|
| **DuckDB** | SQL analytics — columnar scans, aggregations, joins, window functions |
| **LanceDB** | Vector similarity search and full-text search for AI-powered data discovery |
| **Dexie.js** | Reactive UI state — tabs, query history, preferences, crash recovery |

All analytical data transfers use [Apache Arrow IPC](https://arrow.apache.org/docs/format/Columnar.html#ipc-streaming-format), a binary columnar format that avoids the overhead of JSON serialization. Results stream directly from the database engine to the UI with zero-copy buffer transfers.

Your data is stored locally at `~/Library/Application Support/Datspace/`. Nothing is sent to external servers unless you explicitly configure a remote connector.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New query tab |
| `Cmd+W` | Close active tab |
| `Cmd+Shift+[` | Previous tab |
| `Cmd+Shift+]` | Next tab |

## Roadmap

Datspace is being built incrementally:

| Phase | Status |
|-------|--------|
| Foundation — Electron shell, DuckDB, Arrow IPC, query editor | In progress |
| Local Data — file ingestion, catalog, data grid | Planned |
| Remote Connectors — S3, BigQuery, SaaS integrations | Planned |
| Advanced Visualization — charts, dashboards, cross-filtering | Planned |
| AI Integration — Claude conversation, RAG, natural language queries | Planned |
| Publishing — export to HTML, shareable snapshots | Planned |
| Polish — performance, accessibility, UX refinements | Planned |

## License

MIT
