# datspace Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-05

## Active Technologies

- TypeScript 5.4+, Node.js (via Electron v33+) + Electron v33+, @duckdb/node-api ^1.4.4 (Neo client), @uwdata/flechette ^2.3.0, React 18, Dexie.js ^4.3.0 + dexie-react-hooks (001-electron-foundation)
- DuckDB (`~/Library/Application Support/Datspace/analytics.duckdb`), Dexie.js (IndexedDB in Renderer), JSON config file (001-electron-foundation)

## Project Structure

```text
src/
├── main/          # Electron Main Process (lifecycle, IPC, query routing)
├── preload/       # contextBridge typed API (window.datspace)
├── renderer/      # React UI, Dexie.js stores, Arrow decode
├── workers/       # DuckDB Worker Thread (N-API addon, Arrow IPC)
└── shared/        # Types, constants, error taxonomy

tests/
├── unit/
├── integration/
└── e2e/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript: Follow standard conventions
- Arrow IPC for all data-plane transfers (Constitution Principle I)
- No JSON serialization in data-plane hot paths
- Process isolation: Main owns lifecycle, Workers own databases, Renderer owns UI
- Dexie.js runs in Renderer (documented Principle IV deviation)

## Recent Changes

- 001-electron-foundation: Added TypeScript 5.4+ + Electron v33+ + DuckDB + Arrow IPC + React + Dexie.js

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
