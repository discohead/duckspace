# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Agent-readiness principle**: This codebase is designed so that every type, every boundary, and every message is an unambiguous contract. Code should be modifiable with confidence by reading signatures and schemas alone — never by reading implementations. When in doubt, follow existing patterns in neighboring files. Full rationale: `context/strict-typescript-guide.md`.

## Commands

```bash
# Development
npx electron-forge start              # Launch app in dev mode

# Testing
npm test                              # Run unit + integration tests (vitest)
npm run test:watch                    # Watch mode
npx vitest run tests/unit/main/config.test.ts  # Run a single test file
npm run test:e2e                      # E2e tests (Playwright)

# Quality checks
npm run typecheck                     # tsc --noEmit
npm run lint                          # biome check + eslint
npm run lint:fix                      # Auto-fix lint issues
npm run format                        # Format with biome
npm run check                         # typecheck + lint
npm run check:all                     # Full quality suite

# Architecture & dead code
npm run arch                          # dependency-cruiser rules
npm run dead-code                     # knip unused code detection

# Mutation testing
npm run test:mutation                 # Stryker mutation tests

# Build
npm run package                       # Package for distribution
npm run make                          # Create distributable (DMG/ZIP)
```

## Architecture

Datspace is a desktop analytics workspace (Electron + DuckDB + Arrow IPC). Three processes communicate via two planes:

```
┌─────────────────────────────────────────────────────────┐
│ Main Process                                            │
│  lifecycle.ts → startupSequence / shutdownSequence      │
│  ipc-handlers.ts → ipcMain.handle (control plane)       │
│  query-router.ts → dispatches SQL to Worker             │
│  worker-manager.ts → spawn/health/restart Worker        │
│  config.ts → reads/writes ~/Library/.../config.json     │
└────────┬──────────────────────────┬─────────────────────┘
         │ IPC (invoke/handle)      │ MessagePort bridge
         │ control plane            │ data plane (Arrow IPC)
┌────────▼────────┐    ┌───────────▼──────────────────────┐
│ Renderer        │    │ DuckDB Worker Thread              │
│  React 18 UI    │    │  duckdb-worker.ts → message loop  │
│  Dexie.js state │    │  duckdb-connection.ts → N-API     │
│  Arrow decode   │    │  arrow-stream.ts → batch output   │
│  (flechette)    │    │  Runs: to_arrow_ipc(SQL)          │
└─────────────────┘    └──────────────────────────────────┘
```

**Control plane** (IPC channels in `src/shared/constants.ts`): JSON messages via `ipcMain.handle`/`ipcRenderer.invoke` for queries, catalog, lifecycle, config.

**Data plane** (MessagePort): Arrow IPC buffers transferred zero-copy from Worker → Main bridge → Renderer. Backpressure via ACK messages (window size 4, ~8 MB max in-flight).

### Build System

- **Electron Forge + Vite plugin**. Three Vite configs: `vite.main.config.ts`, `vite.preload.config.ts`, `vite.renderer.config.ts`.
- **Worker build**: NOT a Forge target. Built via `closeBundle` plugin hook in `vite.main.config.ts` as a separate `viteBuild()` into `.vite/build/duckdb-worker.js`.
- **Entry files**: `src/main-entry.ts` and `src/preload-entry.ts` are thin wrappers to avoid Vite output filename collisions in `.vite/build/`.
- **Renderer HTML**: `index.html` must be at project root (Forge Vite plugin sets dev server root there).
- **Preload path**: `path.join(__dirname, 'preload-entry.js')` — relative to `.vite/build/`.

### Key Patterns

- **Path aliases**: `@main/*`, `@renderer/*`, `@workers/*`, `@shared/*`, `@preload/*` (defined in `tsconfig.json`, mirrored in each Vite config).
- **Preload bridge**: `window.datspace` exposed via `contextBridge` with namespaces: `query`, `catalog`, `lifecycle`. Types in `src/preload/api.ts` and `src/shared/types.ts`.
- **Dexie.js in Renderer**: 9 tables (`tabs`, `queries`, `catalog_entries`, `column_schemas`, `query_history`, `preferences`, `worker_health`, `recovery_log`, `app_state`). Reactive hooks via `dexie-react-hooks` in `src/renderer/stores/hooks.ts`.
- **Error taxonomy**: `src/shared/errors.ts` — E1xxx (database), E6xxx (system). `DatspaceError.toIPCError()` for safe serialization across process boundaries.
- **Startup sequence** (9 steps in `lifecycle.ts`): config → IPC handlers → spawn Worker → create QueryRouter → create BrowserWindow → setup MessagePort → wait renderer ready → push initial health → start health monitoring.

## Code Style

### Non-negotiables

- **Zero `any`** — use `unknown` and narrow. **Zero `!` non-null assertions.** **Zero `@ts-ignore`** — use `@ts-expect-error` with explanation if unavoidable.
- **Discriminated unions** — all message/event types use a `type` literal field. New variants must be added to the union AND all `switch` handlers (exhaustiveness via `assertNever`).
- **Zod `.strict().describe()`** — all schemas reject extra fields and document every field. Types derived via `z.infer<>`. No hand-written interfaces for validated data.
- **Named exports only** — no `export default`, no `export *`. Barrel files use explicit re-exports.
- **`import type` for type-only imports** — enforced by `verbatimModuleSyntax` and Biome.
- **Error factory functions** (`querySyntaxError()`, `workerCrashedError()`, etc.) — not raw `new DatspaceError()` constructors.
- **`as const satisfies Record<K, V>`** for dispatch maps — compile-time exhaustiveness, not runtime checks.
- **TSDoc on all exports** — `/** */` with `@param`, `@returns`, `@throws`. This is the interface contract agents read first.

### Conventions

- **Arrow IPC for all data-plane transfers** — no JSON serialization in data hot paths (Constitution Principle I).
- **Process isolation**: Main owns lifecycle/routing, Workers own databases, Renderer owns UI. Main must NOT relay data-plane buffers after MessagePort setup.
- All shared types in `src/shared/types.ts`, all shared constants in `src/shared/constants.ts`. Schemas in `src/shared/schemas/`.
- **Strict TypeScript**: All strict flags enabled including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`.
- **Dual linting**: Biome (formatting + non-type-aware rules) + ESLint v9 flat config (type-aware rules). No formatting rules in ESLint.
- DuckDB `@duckdb/node-api` (Neo client) — does NOT have `estimated_size` in `information_schema.tables`.
- Worker error responses (`type: 'error'`) must be handled by all QueryRouter promise-based handlers, not just the expected response type.
- **Vite externals**: Worker imports must use `'worker_threads'` (not `'node:worker_threads'`) to match Vite's external config.

## Testing

- **Vitest** for unit/integration (runs in Node environment). Config: `vitest.config.ts`.
- Tests mirror source structure: `tests/unit/main/`, `tests/unit/renderer/`, `tests/unit/workers/`, `tests/unit/shared/`, `tests/unit/preload/`.
- Renderer tests use `fake-indexeddb` for Dexie.js, `jsdom` for DOM, `@testing-library/react` for components.
- **Playwright** for e2e tests in `tests/e2e/`.
- **Property-based testing** with `fast-check` (e.g., `config-validation.property.test.ts`).
- **Mutation testing** with Stryker (`npm run test:mutation`).
- Many strict lint rules are relaxed for test files — see `eslint.config.mjs` test overrides and `biome.json` test overrides.

## Quality Gates

- **Pre-commit hooks** (Husky + lint-staged): Biome auto-formats staged `.ts`/`.tsx`/`.json`/`.md` files.
- **Architecture enforcement** (`npm run arch`): dependency-cruiser prevents cross-process imports (Main cannot import Renderer, Renderer cannot import Main, Workers cannot import either, Shared cannot import process-specific code).
- **Dead code detection** (`npm run dead-code`): knip finds unused exports, dependencies, and files.
- **CI pipeline** (`.github/workflows/ci.yml`): 7 parallel jobs — lint, typecheck, test, architecture, dead-code, security audit, mutation testing (main branch only).

## Playwright MCP (Visual Testing)

The `playwright-electron` MCP server enables visual interaction with the running Electron app. Config: `.claude/playwright-electron.config.json`.

**Prerequisites before using MCP tools:**
1. **Vite dev server** must be running on port 5173 — the dev build hardcodes `http://localhost:5173` as the renderer URL. Start with: `npx vite --config vite.renderer.config.ts --port 5173`
2. **Build artifacts** must exist in `.vite/build/`: `main-entry.js`, `preload-entry.js`, `duckdb-worker.js`. Run `npx electron-forge start` once to produce them (or rebuild the worker standalone — see Build System above).
3. **No stale Electron processes** — `requestSingleInstanceLock()` causes new instances to silently quit if an old one holds the lock. Check with `ps aux | grep electron.*main-entry` and kill any strays.

**Key tools:** `electron_first_window` (launches app + returns window), `browser_snapshot` (accessibility tree for interaction), `browser_take_screenshot` (visual capture), `browser_click`/`browser_type` (UI interaction).

**Critical: `ELECTRON_RUN_AS_NODE`** — Claude Code sets `ELECTRON_RUN_AS_NODE=1` in its environment. This must be unset for the MCP server process (configured via `claude mcp add -e ELECTRON_RUN_AS_NODE=`). Do NOT use `launchOptions.env` in the Playwright config to fix this — Playwright's `_electron.launch()` REPLACES the entire `process.env` when `env` is specified, stripping PATH/HOME/etc.

## Specs

Feature specifications live in `specs/{feature-id}/` with `spec.md`, `plan.md`, `tasks.md`, and contracts. Constitution at `.specify/memory/constitution.md`.

## Active Technologies
- TypeScript 5.4, Node.js 20.18.0 (Electron 33), React 18.3 + `@duckdb/node-api` v1.4.4 (OLAP + file parsing), `@finos/perspective` + `@finos/perspective-viewer` + `@finos/perspective-viewer-datagrid` + `@finos/perspective-react` (data grid), `chokidar` v4 (file watching), `@uwdata/flechette` v2.3.0 (Arrow IPC decode for metadata), `dexie` v4.3.0 (catalog state), `zod` v4.3.6 (schema validation) (002-local-data-ingestion)
- DuckDB (Worker Thread #1 — file parsing + analytics), Dexie.js/IndexedDB (Renderer — catalog metadata, ingestion jobs, watch configs) (002-local-data-ingestion)

## Recent Changes
- 002-local-data-ingestion: Added TypeScript 5.4, Node.js 20.18.0 (Electron 33), React 18.3 + `@duckdb/node-api` v1.4.4 (OLAP + file parsing), `@finos/perspective` + `@finos/perspective-viewer` + `@finos/perspective-viewer-datagrid` + `@finos/perspective-react` (data grid), `chokidar` v4 (file watching), `@uwdata/flechette` v2.3.0 (Arrow IPC decode for metadata), `dexie` v4.3.0 (catalog state), `zod` v4.3.6 (schema validation)
