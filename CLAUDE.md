# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **Startup sequence** (8 steps in `lifecycle.ts`): config → IPC handlers → spawn Worker → create QueryRouter → create BrowserWindow → setup MessagePort → wait renderer ready → start health monitoring.

## Code Style

- **Arrow IPC for all data-plane transfers** — no JSON serialization in data hot paths (Constitution Principle I).
- **Process isolation**: Main owns lifecycle/routing, Workers own databases, Renderer owns UI. Main must NOT relay data-plane buffers after MessagePort setup.
- DuckDB `@duckdb/node-api` (Neo client) — does NOT have `estimated_size` in `information_schema.tables`.
- Worker error responses (`type: 'error'`) must be handled by all QueryRouter promise-based handlers, not just the expected response type.
- All shared types in `src/shared/types.ts`, all shared constants in `src/shared/constants.ts`.

## Testing

- **Vitest** for unit/integration (runs in Node environment). Config: `vitest.config.ts`.
- Tests mirror source structure: `tests/unit/main/`, `tests/unit/renderer/`, `tests/unit/workers/`, `tests/unit/shared/`, `tests/unit/preload/`.
- Renderer tests use `fake-indexeddb` for Dexie.js, `jsdom` for DOM, `@testing-library/react` for components.
- **Playwright** for e2e tests in `tests/e2e/`.

## Specs

Feature specifications live in `specs/{feature-id}/` with `spec.md`, `plan.md`, `tasks.md`, and contracts. Constitution at `.specify/memory/constitution.md`.
