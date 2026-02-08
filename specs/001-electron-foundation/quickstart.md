# Quickstart: Electron Foundation (Phase 1)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)
**Date**: 2026-02-05

---

## Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 20+ (LTS)
- npm 10+
- Git

Verify your environment:

```bash
node -v   # v20.x or v22.x
npm -v    # 10.x+
git -v
uname -m  # arm64 (Apple Silicon) or x86_64 (Intel)
```

---

## Project Setup

### 1. Initialize the Electron Forge project

```bash
npx create-electron-app@latest datspace -- --template=vite-typescript
cd datspace
```

This scaffolds a project with `@electron-forge/plugin-vite` pre-configured for main, preload, and renderer entry points.

### 2. Install core dependencies

```bash
npm install \
  electron@^33.0.0 \
  @duckdb/node-api@^1.4.4 \
  @uwdata/flechette@^2.3.0 \
  react@^18.0.0 \
  react-dom@^18.0.0 \
  dexie@^4.3.0 \
  dexie-react-hooks
```

| Package | Role |
|---------|------|
| `electron` | Application runtime (Chromium + Node.js) |
| `@duckdb/node-api` | DuckDB Neo client -- N-API native addon, runs in Worker Thread |
| `@uwdata/flechette` | Arrow IPC decoder (~38KB, 1.3-5.4x faster than apache-arrow) |
| `react` / `react-dom` | UI component framework |
| `dexie` / `dexie-react-hooks` | Reactive IndexedDB state (9 collections, `useLiveQuery()`) |

### 3. Install dev dependencies

```bash
npm install --save-dev \
  typescript@^5.4.0 \
  vitest@^3.0.0 \
  @playwright/test@^1.52.0 \
  @vitejs/plugin-react \
  @types/react \
  @types/react-dom \
  @electron-forge/maker-dmg \
  @electron-forge/maker-zip
```

| Package | Role |
|---------|------|
| `typescript` | Type checking across main/renderer/worker/shared |
| `vitest` | Unit + integration tests (fast, native ESM) |
| `@playwright/test` | E2E tests -- launches real Electron app via CDP |
| `@vitejs/plugin-react` | Vite JSX transform for React components |
| `@types/react` / `@types/react-dom` | React type definitions |
| `@electron-forge/maker-dmg` | macOS DMG builder |
| `@electron-forge/maker-zip` | ZIP archive builder |

### 4. Configure forge.config.ts

The critical configuration is externalizing `@duckdb/node-api` so Vite does not attempt to bundle the native N-API addon:

```typescript
// forge.config.ts
import type { ForgeConfig } from '@electron-forge/shared-types';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Datspace',
    appBundleId: 'com.datspace.app',
    icon: './assets/icon',
    // asar: true is default; DuckDB binary resolves from node_modules
  },
  makers: [
    new MakerDMG({}),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          // Main process entry
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          // Preload scripts
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
```

In your Vite main config, externalize the native addon:

```typescript
// vite.main.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        '@duckdb/node-api',   // N-API native addon -- must load from node_modules at runtime
        'worker_threads',     // Node.js built-in
      ],
    },
  },
});
```

### 5. Configure tsconfig.json

Set up path aliases so imports are clean across process boundaries:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "baseUrl": ".",
    "paths": {
      "@main/*": ["src/main/*"],
      "@renderer/*": ["src/renderer/*"],
      "@workers/*": ["src/workers/*"],
      "@shared/*": ["src/shared/*"],
      "@preload/*": ["src/preload/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", ".vite"]
}
```

### 6. Configure vitest.config.ts

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**'],
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@workers': path.resolve(__dirname, 'src/workers'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@preload': path.resolve(__dirname, 'src/preload'),
    },
  },
});
```

For Playwright E2E, create a separate config:

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  retries: 1,
  use: {
    trace: 'on-first-retry',
  },
});
```

---

## Directory Structure

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
│       ├── arrow-decode.ts      # Flechette IPC -> table decode
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

The directory layout mirrors the Electron process model: each folder maps to an isolated execution context. The `shared/` directory contains types and constants that are imported at build time but never create runtime coupling between processes.

---

## Development Workflow

Add these scripts to `package.json`:

```jsonc
{
  "scripts": {
    "start": "electron-forge start",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "npx playwright test",
    "make": "electron-forge make",
    "package": "electron-forge package",
    "lint": "tsc --noEmit"
  }
}
```

| Command | What it does |
|---------|-------------|
| `npm start` | Launch Electron in dev mode with Vite HMR for the renderer |
| `npm test` | Run Vitest unit + integration tests (single run) |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run test:e2e` | Run Playwright E2E tests against the built app |
| `npm run make` | Build a macOS DMG via Electron Forge |
| `npm run package` | Package the app without creating a distributable |
| `npm run lint` | Type-check the entire project |

---

## Key Implementation Notes

### DuckDB Worker Thread Setup

The DuckDB N-API addon runs in a Worker Thread, not the Main Process. This keeps the Main Process responsive and prevents query execution from blocking IPC or window management.

```typescript
// src/main/worker-manager.ts
import { Worker } from 'worker_threads';
import path from 'path';

export function spawnDuckDBWorker(config: {
  dbPath: string;
  memoryLimit: string;
  threads: number;
}): Worker {
  const worker = new Worker(
    path.join(__dirname, '../workers/duckdb-worker.js'),
    {
      workerData: config,
      resourceLimits: {
        maxOldGenerationSizeMb: 512,  // V8 heap limit, separate from DuckDB memory
      },
    }
  );
  return worker;
}
```

```typescript
// src/workers/duckdb-worker.ts
import { parentPort, workerData } from 'worker_threads';
import { DuckDBInstance } from '@duckdb/node-api';

let instance: DuckDBInstance;
let connection: any;

async function init() {
  instance = await DuckDBInstance.create(workerData.dbPath, {
    access_mode: 'READ_WRITE',
    memory_limit: workerData.memoryLimit,
    threads: String(workerData.threads),
  });
  connection = await instance.connect();

  // Load extensions
  await connection.run("LOAD parquet");
  await connection.run("LOAD json");
  await connection.run("LOAD icu");

  // Create system tables if they don't exist
  await connection.run(`
    CREATE TABLE IF NOT EXISTS _query_history (
      query_id VARCHAR PRIMARY KEY,
      sql VARCHAR NOT NULL,
      execution_time_ms INTEGER NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      timestamp TIMESTAMP NOT NULL DEFAULT current_timestamp,
      status VARCHAR NOT NULL DEFAULT 'success',
      error_message VARCHAR
    )
  `);

  parentPort?.postMessage({ type: 'ready' });
}

init().catch((err) => {
  parentPort?.postMessage({ type: 'error', message: err.message });
});
```

**Key point**: `@duckdb/node-api` uses N-API prebuilt binaries. You do NOT need `electron-rebuild`. The addon loads cleanly in Worker Thread V8 isolates.

### Arrow IPC via `to_arrow_ipc()` SQL Function

The DuckDB Neo client does not yet expose a native `arrowIPCAll()` JS method. Use the built-in SQL function instead:

```typescript
// src/workers/arrow-stream.ts
async function executeQueryAsArrow(
  connection: any,
  sql: string
): Promise<Uint8Array> {
  // Wrap the user query in to_arrow_ipc() to get Arrow IPC Stream format
  const wrappedSQL = `SELECT * FROM to_arrow_ipc((${sql}))`;
  const result = await connection.run(wrappedSQL);

  // The result contains a single column with the IPC buffer as a Uint8Array
  const rows = await result.getRows();
  const ipcBuffer: Uint8Array = rows[0][0];

  return ipcBuffer;
}
```

For streaming large results, chunk with LIMIT/OFFSET:

```typescript
async function* streamArrowBatches(
  connection: any,
  sql: string,
  batchSize: number = 100_000
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const batchSQL = `${sql} LIMIT ${batchSize} OFFSET ${offset}`;
    const ipcBuffer = await executeQueryAsArrow(connection, batchSQL);

    // Decode to check row count (or track via DuckDB metadata)
    yield ipcBuffer;

    offset += batchSize;
    // Stop when a batch returns fewer rows than batchSize
    // (actual implementation should check row count from Arrow metadata)
  }
}
```

### MessagePort Channel Setup

The data plane uses `MessagePort` for direct Worker-to-Renderer communication. The Main Process establishes the channel but never relays data-plane buffers.

```typescript
// src/main/ipc-handlers.ts
import { ipcMain, BrowserWindow } from 'electron';
import { MessageChannel } from 'worker_threads';

export function setupDataChannel(
  win: BrowserWindow,
  duckdbWorker: Worker
) {
  const { port1, port2 } = new MessageChannel();

  // Send port1 to the DuckDB Worker
  duckdbWorker.postMessage({ type: 'set_data_port', port: port1 }, [port1]);

  // Send port2 to the Renderer via the preload bridge
  win.webContents.postMessage('set-data-port', null, [port2]);
}
```

On the Worker side, use the port to send Arrow buffers with zero-copy transfer:

```typescript
// In duckdb-worker.ts -- handle data port
let dataPort: MessagePort;

parentPort?.on('message', (msg) => {
  if (msg.type === 'set_data_port') {
    dataPort = msg.port;
  }
});

// When sending Arrow IPC results:
function sendArrowResult(queryId: string, ipcBuffer: Uint8Array) {
  const buffer = ipcBuffer.buffer;
  dataPort.postMessage(
    { type: 'arrow_result', queryId, data: ipcBuffer },
    [buffer]  // Transfer the ArrayBuffer (zero-copy)
  );
}
```

On the Renderer side, decode with Flechette:

```typescript
// src/renderer/lib/arrow-decode.ts
import { tableFromIPC } from '@uwdata/flechette';

export function decodeArrowIPC(buffer: Uint8Array) {
  const table = tableFromIPC(buffer);
  return {
    columns: table.schema.fields.map(f => f.name),
    rowCount: table.numRows,
    // Access column data for the virtual-scrolling grid
    getColumn: (name: string) => table.getChild(name)?.toArray(),
  };
}
```

### Dexie.js Initialization in the Renderer

```typescript
// src/renderer/stores/db.ts
import Dexie from 'dexie';

class DatspaceDB extends Dexie {
  tabs!: Dexie.Table;
  queries!: Dexie.Table;
  catalog_entries!: Dexie.Table;
  column_schemas!: Dexie.Table;
  query_history!: Dexie.Table;
  preferences!: Dexie.Table;
  worker_health!: Dexie.Table;
  recovery_log!: Dexie.Table;
  app_state!: Dexie.Table;

  constructor() {
    super('Datspace');

    this.version(1).stores({
      tabs:            'id, type, order',
      queries:         'id, tabId, status, startedAt',
      catalog_entries: 'id, name, type, status, registeredAt',
      column_schemas:  'id, catalogEntryId, [catalogEntryId+columnName]',
      query_history:   'id, timestamp, *tags',
      preferences:     'id',
      worker_health:   'id',
      recovery_log:    'id, timestamp',
      app_state:       'id',
    });
  }
}

const db = new DatspaceDB();
export default db;
```

Use reactive queries in components:

```typescript
// src/renderer/stores/hooks.ts
import { useLiveQuery } from 'dexie-react-hooks';
import db from './db';

export function useTabs() {
  return useLiveQuery(() => db.tabs.orderBy('order').toArray(), []);
}

export function useWorkerHealth() {
  return useLiveQuery(() => db.worker_health.get('duckdb'), []);
}

export function useActiveQuery(tabId: string) {
  return useLiveQuery(
    () => db.queries.where({ tabId, status: 'running' }).first(),
    [tabId]
  );
}
```

### contextBridge / Preload Configuration

The Renderer cannot access Node.js APIs directly. The preload script exposes a typed API via `contextBridge`:

```typescript
// src/preload/api.ts
export interface DatspaceAPI {
  query: {
    execute(sql: string): Promise<{ queryId: string }>;
    cancel(queryId: string): Promise<void>;
    getHistory(limit?: number): Promise<any[]>;
  };
  catalog: {
    listTables(): Promise<any[]>;
    getColumns(tableName: string): Promise<any[]>;
  };
  lifecycle: {
    onShutdown(callback: () => void): void;
    getConfig(): Promise<any>;
  };
}
```

```typescript
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { DatspaceAPI } from './api';

const api: DatspaceAPI = {
  query: {
    execute: (sql) => ipcRenderer.invoke('query:execute', sql),
    cancel: (queryId) => ipcRenderer.invoke('query:cancel', queryId),
    getHistory: (limit) => ipcRenderer.invoke('query:history', limit),
  },
  catalog: {
    listTables: () => ipcRenderer.invoke('catalog:list-tables'),
    getColumns: (name) => ipcRenderer.invoke('catalog:get-columns', name),
  },
  lifecycle: {
    onShutdown: (cb) => ipcRenderer.on('app:shutdown', cb),
    getConfig: () => ipcRenderer.invoke('lifecycle:get-config'),
  },
};

contextBridge.exposeInMainWorld('datspace', api);
```

In the Main Process, set up the BrowserWindow with the preload script:

```typescript
// src/main/index.ts
import { app, BrowserWindow } from 'electron';
import path from 'path';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: 'hiddenInset',  // macOS native traffic-light buttons
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,      // REQUIRED -- separates preload from renderer
      nodeIntegration: false,      // REQUIRED -- no Node.js in renderer
      sandbox: false,              // Must be false for preload to use Node.js APIs
    },
  });

  // In dev, load from Vite dev server; in production, load the built file
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  return win;
}
```

---

## App Data Paths

All persistent data lives under `~/Library/Application Support/Datspace/`:

| Path | Contents |
|------|----------|
| `analytics.duckdb` | DuckDB analytical database file |
| `analytics.duckdb.wal` | DuckDB write-ahead log (auto-managed) |
| `config.json` | Machine-specific configuration (memory, threads, paths) |
| `tmp/` | DuckDB spill-to-disk directory (cleaned on graceful shutdown) |
| `IndexedDB/` | Dexie.js data (managed by Chromium, do not modify directly) |

---

## Verification Checklist

After completing the implementation, verify each item:

- [ ] **App launches in < 2s** -- Time from double-click to interactive window on a 16 GB Mac.
- [ ] **`SELECT 42 AS answer` returns result in data grid** -- Execute in query editor, confirm one row with column "answer" and value 42.
- [ ] **Tab state persists across restart** -- Open 3 tabs with different SQL, quit with Cmd+Q, relaunch, confirm all 3 tabs restore with their SQL text.
- [ ] **DuckDB Worker health monitoring active** -- Check StatusBar shows worker status. Force-kill the worker (in dev tools) and confirm it restarts within 60s.
- [ ] **Arrow IPC data transfer (not JSON) confirmed** -- Add a log statement in `arrow-decode.ts` that prints the buffer byte length. Execute a query and confirm the log fires (data arrived as Arrow IPC, not JSON).
- [ ] **Query cancellation works** -- Execute `SELECT * FROM range(100000000)`, click cancel, confirm it stops within 1 second.
- [ ] **Crash recovery works** -- Force-quit the app (kill -9), relaunch, confirm the recovery log entry is created and all tables are still accessible.
- [ ] **macOS native integration** -- Traffic-light window buttons render correctly. Cmd+Q triggers graceful shutdown. App appears in the dock.
- [ ] **Large result set streams** -- Execute a query returning 1M+ rows. First rows appear within 1 second. Virtual scroll works at >30fps.
- [ ] **Memory stays under budget** -- With 3-5 tabs and 1 active query, total memory footprint stays below 2 GB (check Activity Monitor).

---

## Troubleshooting

**DuckDB addon fails to load in Worker Thread**
- Confirm Electron v33+ is installed (`npx electron -v`). The Neo client requires Node-API v9.
- Confirm `@duckdb/node-api` is externalized in `vite.main.config.ts` -- it must not be bundled.
- Check that the Worker Thread is spawned with the correct path to the compiled JS file (post-Vite build).

**Arrow IPC buffer is empty or malformed**
- Verify the SQL passed to `to_arrow_ipc()` is valid. The inner query must be wrapped in parentheses: `SELECT * FROM to_arrow_ipc((SELECT ...))`.
- Check that the `Uint8Array` is being transferred (not cloned) via `MessagePort` by including the `.buffer` in the transferable list.

**Dexie.js schema version mismatch**
- If you change the Dexie.js schema, increment the version number. Dexie will not run migrations if the version number stays the same.
- To reset during development: open Chrome DevTools in the Renderer, go to Application > IndexedDB, delete the "Datspace" database.

**Vite HMR not working for Renderer**
- Confirm `@vitejs/plugin-react` is in `vite.renderer.config.ts` plugins.
- HMR only works for the renderer process. Main and preload changes require a full restart (`Ctrl+C` then `npm start`).

---

*This is a developer quickstart guide. For the full architecture rationale, see [spec.md](spec.md). For implementation sequencing, see [plan.md](plan.md). For the data model, see [data-model.md](data-model.md).*
