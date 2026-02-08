import { describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------
const browserWindowConstructorArgs: any[] = [];

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    isPackaged: false,
  },
  BrowserWindow: vi.fn((...args: any[]) => {
    browserWindowConstructorArgs.push(args[0]);
    return {
      on: vi.fn(),
      once: vi.fn(),
      loadURL: vi.fn(),
      loadFile: vi.fn(),
      show: vi.fn(),
      isDestroyed: vi.fn(() => false),
      getBounds: vi.fn(() => ({ x: 100, y: 100, width: 1280, height: 800 })),
      webContents: { send: vi.fn(), postMessage: vi.fn() },
    };
  }),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    rmSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
}));

const mockWorkerInstance = { on: vi.fn(), postMessage: vi.fn() };
vi.mock('@main/worker-manager', () => ({
  WorkerManager: vi.fn(() => ({
    spawn: vi.fn().mockResolvedValue(undefined),
    getWorker: vi.fn(() => mockWorkerInstance),
    setMainWindow: vi.fn(),
    pushCurrentHealth: vi.fn(),
    startHealthMonitoring: vi.fn(),
    stopHealthMonitoring: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@main/query-router', () => ({
  QueryRouter: vi.fn(() => ({
    setMainWindow: vi.fn(),
    beginShutdown: vi.fn(),
  })),
}));

vi.mock('@main/config', () => ({
  loadConfig: vi.fn(() => ({
    duckdb: {
      memoryLimitPercent: 50,
      memoryLimitOverrideMB: null,
      threads: null,
      extensions: [],
    },
    paths: { database: 'test.duckdb', tempDir: 'tmp', config: 'config.json' },
    workers: {
      healthCheckIntervalMs: 60000,
      heartbeatTimeoutMs: 5000,
      maxRestartAttempts: 3,
      v8HeapLimitMB: 512,
    },
    ui: { theme: 'system', fontSize: 14, defaultQueryLimit: 1000 },
    lifecycle: { shutdownTimeoutMs: 6000, walCheckpointOnShutdown: true },
  })),
  ensureDirectories: vi.fn(),
  getDatabasePath: vi.fn(() => '/tmp/test.duckdb'),
  getTempDirectory: vi.fn(() => '/tmp'),
  computeMemoryLimit: vi.fn(() => '4096MB'),
  computeThreadCount: vi.fn(() => 4),
}));

vi.mock('@main/ipc-handlers', () => ({
  registerIPCHandlers: vi.fn(),
  setupDataChannel: vi.fn(),
  setMainWindowRef: vi.fn(),
  setQueryRouter: vi.fn(),
  setWorkerManager: vi.fn(),
  setIngestionReady: vi.fn(),
  waitForRendererReady: vi.fn().mockResolvedValue(undefined),
  waitForShutdownAck: vi.fn().mockResolvedValue(true),
  sendShutdownPrepare: vi.fn(),
}));

vi.mock('@main/ingestion/ingestion-router', () => ({
  setWorker: vi.fn(),
  setMainWindow: vi.fn(),
}));

// Stub Vite-injected globals
vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe('lifecycle — Regression', () => {
  // N2: Sandbox must be enabled
  it('creates BrowserWindow with sandbox: true (N2)', async () => {
    browserWindowConstructorArgs.length = 0;

    // startupSequence internally calls createWindow() which creates BrowserWindow
    const { startupSequence } = await import('@main/lifecycle');
    await startupSequence();

    expect(browserWindowConstructorArgs.length).toBeGreaterThan(0);
    const opts = browserWindowConstructorArgs[0];
    expect(opts.webPreferences.sandbox).toBe(true);
  });
});
