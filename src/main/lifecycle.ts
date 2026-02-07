import fs from 'node:fs';
import path from 'node:path';
import { PUSH_EVENTS, TIMEOUTS } from '@shared/constants';
import { app, BrowserWindow } from 'electron';
import {
  computeMemoryLimit,
  computeThreadCount,
  ensureDirectories,
  getDatabasePath,
  getTempDirectory,
  loadConfig,
} from './config';
import {
  registerIPCHandlers,
  sendShutdownPrepare,
  setMainWindowRef,
  setQueryRouter,
  setupDataChannel,
  setWorkerManager,
  waitForRendererReady,
  waitForShutdownAck,
} from './ipc-handlers';
import { QueryRouter } from './query-router';
import { WorkerManager } from './worker-manager';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let workerManager: WorkerManager | null = null;
let queryRouter: QueryRouter | null = null;

/**
 * Returns the current main BrowserWindow instance.
 *
 * @returns The main window, or null if not yet created or already closed.
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Returns the current WorkerManager instance.
 *
 * @returns The worker manager, or null if not yet initialized.
 */
export function getWorkerManager(): WorkerManager | null {
  return workerManager;
}

/**
 * Returns the current QueryRouter instance.
 *
 * @returns The query router, or null if not yet initialized.
 */
export function getQueryRouter(): QueryRouter | null {
  return queryRouter;
}

// T064: Window bounds persistence
let boundsDebounce: ReturnType<typeof setTimeout> | null = null;

function setupWindowBoundsTracking(win: BrowserWindow): void {
  const saveBounds = (): void => {
    if (boundsDebounce) clearTimeout(boundsDebounce);
    boundsDebounce = setTimeout(() => {
      if (!win.isDestroyed()) {
        const bounds = win.getBounds();
        // Send to renderer to persist in Dexie.js app_state
        win.webContents.send(PUSH_EVENTS.WINDOW_BOUNDS_CHANGED, bounds);
      }
    }, 500);
  };

  win.on('move', saveBounds);
  win.on('resize', saveBounds);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload-entry.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // T064: Track window bounds changes
  setupWindowBoundsTracking(win);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return win;
}

/**
 * Executes the 8-step application startup sequence.
 *
 * Steps: load config, register IPC handlers, spawn DuckDB worker, create QueryRouter,
 * create BrowserWindow, setup MessagePort data channel, wait for renderer ready,
 * and start health monitoring.
 *
 * @throws {@link Error} If the worker fails to spawn or the renderer does not signal ready.
 */
export async function startupSequence(): Promise<void> {
  // Step 1: Read configuration
  const config = loadConfig();
  ensureDirectories();

  // Step 2: Register IPC handlers (must be before window creation)
  registerIPCHandlers();

  // Step 3: Spawn DuckDB Worker
  // T069: Resolve bundled extension directory for production builds
  let extensionDirectory: string | undefined;
  if (app.isPackaged) {
    const bundledExtDir = path.join(process.resourcesPath, 'duckdb-extensions');
    if (fs.existsSync(bundledExtDir)) {
      extensionDirectory = bundledExtDir;
    }
  }

  workerManager = new WorkerManager({
    dbPath: getDatabasePath(),
    memoryLimit: computeMemoryLimit(),
    threads: computeThreadCount(),
    tempDirectory: getTempDirectory(),
    extensions: config.duckdb.extensions,
    ...(extensionDirectory !== undefined ? { extensionDirectory } : {}),
    v8HeapLimitMB: config.workers.v8HeapLimitMB,
    healthCheckIntervalMs: config.workers.healthCheckIntervalMs,
    heartbeatTimeoutMs: config.workers.heartbeatTimeoutMs,
    maxRestartAttempts: config.workers.maxRestartAttempts,
  });

  setWorkerManager(workerManager);
  await workerManager.spawn();

  // Step 4: Create QueryRouter
  const worker = workerManager.getWorker();
  if (!worker) throw new Error('Worker not available after spawn');
  queryRouter = new QueryRouter(worker);
  setQueryRouter(queryRouter);

  // Step 5: Create BrowserWindow
  mainWindow = createWindow();
  setMainWindowRef(mainWindow);
  workerManager.setMainWindow(mainWindow);
  queryRouter.setMainWindow(mainWindow);

  // Step 6: Setup MessagePort data channel
  setupDataChannel(mainWindow, worker);

  // Step 7: Wait for renderer ready
  await waitForRendererReady();

  // Step 8: Push initial worker health to renderer (the 'ready' push in step 3
  // fired before the window existed, so the renderer never received it)
  workerManager.pushCurrentHealth();

  // Step 9: Begin health monitoring
  workerManager.startHealthMonitoring();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Executes the graceful shutdown sequence.
 *
 * Stops accepting queries, notifies the renderer, waits for acknowledgment,
 * shuts down the DuckDB worker, cleans the temp directory, and quits the app.
 */
export async function shutdownSequence(): Promise<void> {
  // Step 1: Stop accepting queries
  if (queryRouter) {
    queryRouter.beginShutdown();
  }

  // Step 2: Send shutdown-prepare to renderer
  sendShutdownPrepare();

  // Step 3: Wait for shutdown acknowledgment (5s timeout)
  await waitForShutdownAck(TIMEOUTS.SHUTDOWN_ACK);

  // Step 4: Shutdown DuckDB worker
  if (workerManager) {
    workerManager.stopHealthMonitoring();
    await workerManager.shutdown();
  }

  // Step 5: Config is already saved by the config module

  // Step 5.5: Clean tmp/ directory contents (best-effort)
  try {
    const tmpDir = getTempDirectory();
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(tmpDir, entry.name);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // Ignore per-entry errors; shutdown must proceed
      }
    }
  } catch {
    // tmp/ may not exist or be unreadable; not fatal
  }

  // Step 6: Quit
  app.quit();
}
