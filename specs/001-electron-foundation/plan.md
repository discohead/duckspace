# Implementation Plan: Electron Foundation (Phase 1)

**Branch**: `001-electron-foundation` | **Date**: 2026-02-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-electron-foundation/spec.md`

## Summary

Build the datspace Electron application shell with embedded DuckDB for OLAP analytics, Apache Arrow IPC for data transfer between Worker Threads and the Renderer, and Dexie.js for reactive UI state. The deliverable is a functional macOS desktop application where a user can launch the app, write SQL queries, see results in a virtual-scrolling data grid, browse table schemas, and have their session state persist across restarts. Crash recovery, backpressure-controlled streaming, and health-monitored worker processes provide production-grade reliability from day one.

## Technical Context

**Language/Version**: TypeScript 5.4+, Node.js (via Electron v33+)
**Primary Dependencies**: Electron v33+, @duckdb/node-api ^1.4.4 (Neo client), @uwdata/flechette ^2.3.0, React 18, Dexie.js ^4.3.0 + dexie-react-hooks
**Storage**: DuckDB (`~/Library/Application Support/Datspace/analytics.duckdb`), Dexie.js (IndexedDB in Renderer), JSON config file
**Testing**: Vitest ^3.x (unit/integration), Playwright ^1.52+ (E2E with Electron CDP support)
**Target Platform**: macOS (Apple Silicon arm64 + Intel x64)
**Project Type**: Single Electron application (monorepo-style with main/renderer/worker source trees)
**Performance Goals**: <2s launch to interactive, <500ms small query round-trip, first rows within 1s for 1M-row queries, >30fps virtual scroll
**Constraints**: <2GB memory footprint (typical usage), <340MB bundle size, DuckDB memory = 50% system RAM, Arrow cache = 256MB LRU
**Scale/Scope**: Single user, 3-10 open query tabs, result sets up to millions of rows via streaming

### Key Research Findings

1. **DuckDB Native Addon**: Use `@duckdb/node-api` (Neo client) ^1.4.4. N-API based with prebuilt binaries — `electron-rebuild` NOT required. Critical caveat: the Neo client does not yet expose a native `arrowIPCAll()` method. Workaround: use DuckDB's built-in `to_arrow_ipc()` SQL function to produce Arrow IPC buffers directly from SQL, then transfer the resulting `Uint8Array` via `MessagePort`.

2. **Arrow JS Library**: Use `@uwdata/flechette` ^2.3.0 instead of `apache-arrow`. Flechette is 4x smaller (~38KB min+gz vs ~150KB), 1.3-5.4x faster decoding, and has better DuckDB type coverage (LIST, MAP, UNION). DuckDB team recommends it. Zero-copy IPC decode via `tableFromIPC()`.

3. **Build Tooling**: Electron Forge v7.x with `@electron-forge/plugin-vite` for the renderer build pipeline. Vite handles HMR, TypeScript, and React JSX. Forge handles packaging, code signing, and DMG creation.

4. **Electron Version**: v33+ (not v28 which is EOL). v33+ provides Node-API v9 compatibility needed by `@duckdb/node-api` prebuilt binaries, and includes latest Chromium security patches.

5. **Testing Stack**: Vitest ^3.x for unit and integration tests (fast, native ESM, TypeScript). Playwright ^1.52+ for E2E tests using Electron's CDP (Chrome DevTools Protocol) support — launches the actual Electron app, drives it via the Chromium automation protocol.

6. **Dexie.js**: v4.3.0 with `dexie-react-hooks` for `useLiveQuery()`. First-class Electron/IndexedDB support. 9 collections defined in the data model spec (tabs, queries, catalog_entries, column_schemas, query_history, preferences, worker_health, recovery_log, app_state).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | Arrow-First Data Flow | PASS | All DuckDB query results transfer as Arrow IPC via `to_arrow_ipc()` → `MessagePort` with `ArrayBuffer` transfer. Flechette decodes in Renderer. No JSON on data plane. Control messages (query descriptors, ACKs, lifecycle) use JSON. |
| II | Embedded-Only Databases | PASS | DuckDB runs as N-API addon in Worker Thread #1. Dexie.js runs in Renderer (IndexedDB). No external database servers. LanceDB deferred to Phase 5 (not in scope). |
| III | Stream and Scan | PASS | Chunked Arrow RecordBatch streaming with adaptive ~2MB batches. Window-based backpressure (window=4, ~8MB in-flight). Virtual scrolling in data grid — Renderer holds only visible rows + buffer. All filtering/sorting pushed to DuckDB. |
| IV | Process Isolation | PASS | Main Process: lifecycle, IPC dispatch, query routing. Worker Thread #1: DuckDB addon, Arrow IPC output. Renderer: React UI, Dexie.js state, data grid. MessagePort channels for direct Worker→Renderer data transfer; Main never relays data-plane buffers. |
| V | macOS-First | PASS | Targets macOS arm64 + x64 only. Native traffic-light buttons, Cmd+Q, dock integration. App data at `~/Library/Application Support/Datspace/`. No cross-platform considerations. |
| VI | Single-User, Local-First | PASS | Single user, no auth, no sync. All data local. No network connectivity required for core functionality. |

**Gate result**: ALL PASS — proceed to implementation planning.

## Project Structure

### Documentation (this feature)

```text
specs/001-electron-foundation/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── ipc-channels.md
│   ├── preload-api.md
│   └── dexie-schema.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
src/
├── main/
│   ├── index.ts                 # Electron Main Process entry
│   ├── lifecycle.ts             # App startup/shutdown sequences
│   ├── ipc-handlers.ts          # IPC message routing
│   ├── query-router.ts          # Query dispatch to DuckDB Worker
│   ├── worker-manager.ts        # Worker Thread lifecycle + health monitoring
│   └── config.ts                # App configuration (memory limits, paths)
│
├── preload/
│   ├── index.ts                 # contextBridge exposure
│   └── api.ts                   # Typed window.datspace API definition
│
├── renderer/
│   ├── index.html               # Renderer entry HTML
│   ├── index.tsx                # React app entry
│   ├── App.tsx                  # Root component
│   ├── components/
│   │   ├── TabBar.tsx           # Tab management UI
│   │   ├── QueryEditor.tsx      # SQL editor component
│   │   ├── ResultGrid.tsx       # Virtual-scrolling data grid
│   │   ├── CatalogBrowser.tsx   # Schema browser
│   │   └── StatusBar.tsx        # Query status, worker health
│   ├── stores/
│   │   ├── db.ts                # Dexie.js database definition (9 collections)
│   │   └── hooks.ts             # useLiveQuery wrappers
│   └── lib/
│       ├── arrow-decode.ts      # Flechette IPC → table decode
│       └── backpressure.ts      # Window-based flow control (Renderer side)
│
├── workers/
│   ├── duckdb-worker.ts         # DuckDB Worker Thread entry
│   ├── duckdb-connection.ts     # DuckDB N-API connection management
│   └── arrow-stream.ts          # Arrow IPC batch production + backpressure
│
└── shared/
    ├── types.ts                 # Shared TypeScript types (messages, entities)
    ├── constants.ts             # Channel names, config defaults
    └── errors.ts                # Error taxonomy (E1xxx-E9xxx)

tests/
├── unit/
│   ├── query-router.test.ts
│   ├── arrow-decode.test.ts
│   ├── backpressure.test.ts
│   └── dexie-store.test.ts
├── integration/
│   ├── duckdb-worker.test.ts
│   ├── ipc-roundtrip.test.ts
│   └── arrow-streaming.test.ts
└── e2e/
    ├── app-launch.test.ts
    ├── query-execution.test.ts
    └── tab-persistence.test.ts
```

**Structure Decision**: Single Electron application with `src/` organized by process boundary (main, preload, renderer, workers, shared). This mirrors the Electron process model and makes the isolation boundaries physically visible in the file system. Tests mirror source structure with unit/integration/e2e tiers.

## Complexity Tracking

No constitution violations — no entries needed.
