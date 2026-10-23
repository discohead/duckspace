// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock react-dom/client
const mockRender = vi.fn();
vi.mock('react-dom/client', () => ({
  createRoot: vi.fn().mockReturnValue({ render: mockRender }),
}));

// Mock db
const mockDbOpen = vi.fn().mockResolvedValue(undefined);
const mockPrefCount = vi.fn().mockResolvedValue(0);
const mockPrefBulkAdd = vi.fn().mockResolvedValue(undefined);
const mockAppStatePut = vi.fn().mockResolvedValue(undefined);
const mockAppStateGet = vi.fn().mockResolvedValue(null);
const mockTabsModify = vi.fn();
const mockTabsGet = vi.fn().mockResolvedValue(null);
const mockTabsUpdate = vi.fn().mockResolvedValue(1);
const mockQueryHistoryPut = vi.fn();
const mockWorkerHealthPut = vi.fn();

vi.mock('@renderer/stores/db', () => {
  const mockDb = {
    open: mockDbOpen,
    preferences: {
      count: mockPrefCount,
      bulkAdd: mockPrefBulkAdd,
    },
    app_state: {
      put: mockAppStatePut,
      get: mockAppStateGet,
    },
    tabs: {
      toCollection: vi.fn().mockReturnValue({ modify: mockTabsModify }),
      get: mockTabsGet,
      update: mockTabsUpdate,
    },
    query_history: { put: mockQueryHistoryPut },
    worker_health: { put: mockWorkerHealthPut },
  };
  return { db: mockDb };
});

// Mock recovery module
const mockCheckAndRecover = vi.fn().mockResolvedValue(false);
vi.mock('@renderer/lib/recovery', () => ({
  checkAndRecover: mockCheckAndRecover,
}));

// Mock constants (pass through actual values)
vi.mock('@shared/constants', async () => {
  const actual = await vi.importActual('@shared/constants');
  return actual;
});

describe('renderer bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Reset mock defaults
    mockDbOpen.mockResolvedValue(undefined);
    mockPrefCount.mockResolvedValue(0);
    mockPrefBulkAdd.mockResolvedValue(undefined);
    mockAppStatePut.mockResolvedValue(undefined);
    mockAppStateGet.mockResolvedValue(null);
    mockCheckAndRecover.mockResolvedValue(false);
    mockTabsGet.mockResolvedValue(null);
    mockRender.mockReset();

    // Mock crypto.randomUUID
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('mock-session-uuid'),
    });

    // Mock document.getElementById
    const mockRootElement = document.createElement('div');
    mockRootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(mockRootElement);

    // Mock window.duckspace
    window.duckspace = {
      query: {
        execute: vi.fn(),
        cancel: vi.fn(),
        onStatus: vi.fn().mockReturnValue(() => {}),
        onData: vi.fn().mockReturnValue(() => {}),
        onQueryHistory: vi.fn().mockReturnValue(() => {}),
      },
      catalog: {
        listTables: vi.fn(),
        describeTable: vi.fn(),
        previewTable: vi.fn(),
      },
      lifecycle: {
        ready: vi.fn().mockResolvedValue(undefined),
        getAppState: vi.fn(),
        shutdownAck: vi.fn(),
        onWorkerHealth: vi.fn().mockReturnValue(() => {}),
        onShutdownPrepare: vi.fn().mockReturnValue(() => {}),
        onBoundsChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;
  });

  async function runBootstrap() {
    // Dynamic import triggers bootstrap() at module level
    await import('@renderer/index');
    // Give the async bootstrap a tick to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('opens db during bootstrap', async () => {
    await runBootstrap();
    expect(mockDbOpen).toHaveBeenCalled();
  });

  it('seeds preferences when count is 0', async () => {
    mockPrefCount.mockResolvedValue(0);
    await runBootstrap();
    expect(mockPrefBulkAdd).toHaveBeenCalled();
  });

  it('does not seed preferences when they already exist', async () => {
    mockPrefCount.mockResolvedValue(6);
    await runBootstrap();
    expect(mockPrefBulkAdd).not.toHaveBeenCalled();
  });

  it('calls checkAndRecover', async () => {
    await runBootstrap();
    expect(mockCheckAndRecover).toHaveBeenCalled();
  });

  it('marks shutdown_status as dirty', async () => {
    await runBootstrap();
    expect(mockAppStatePut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'shutdown_status',
        value: 'dirty',
      }),
    );
  });

  it('generates session_id', async () => {
    await runBootstrap();
    expect(mockAppStatePut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session_id',
        value: 'mock-session-uuid',
      }),
    );
  });

  it('stores recovery_triggered when recovery happens', async () => {
    mockCheckAndRecover.mockResolvedValue(true);
    await runBootstrap();
    expect(mockAppStatePut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'recovery_triggered',
        value: true,
      }),
    );
  });

  it('does not store recovery_triggered when no recovery', async () => {
    mockCheckAndRecover.mockResolvedValue(false);
    await runBootstrap();
    const recoveryCall = mockAppStatePut.mock.calls.find(
      (call: unknown[]) => (call[0] as { id: string }).id === 'recovery_triggered',
    );
    expect(recoveryCall).toBeUndefined();
  });

  it('restores last active tab if available', async () => {
    mockAppStateGet.mockImplementation(async (key: string) => {
      if (key === 'last_active_tab_id') {
        return { id: 'last_active_tab_id', value: 'tab-42' };
      }
      return null;
    });
    mockTabsGet.mockResolvedValue({
      id: 'tab-42',
      type: 'query',
      order: 0,
      title: 'Restored Tab',
      active: false,
    });
    await runBootstrap();
    expect(mockTabsModify).toHaveBeenCalledWith({ active: false });
    expect(mockTabsUpdate).toHaveBeenCalledWith('tab-42', { active: true });
  });

  it('creates React root and renders', async () => {
    const { createRoot } = await import('react-dom/client');
    await runBootstrap();
    expect(createRoot).toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
  });

  it('calls lifecycle.ready after rendering', async () => {
    await runBootstrap();
    expect(window.duckspace.lifecycle.ready).toHaveBeenCalled();
  });

  it('registers shutdown handler', async () => {
    await runBootstrap();
    expect(window.duckspace.lifecycle.onShutdownPrepare).toHaveBeenCalled();
  });

  it('registers bounds handler', async () => {
    await runBootstrap();
    expect(window.duckspace.lifecycle.onBoundsChanged).toHaveBeenCalled();
  });

  it('registers query history handler', async () => {
    await runBootstrap();
    expect(window.duckspace.query.onQueryHistory).toHaveBeenCalled();
  });

  it('registers worker health handler', async () => {
    await runBootstrap();
    expect(window.duckspace.lifecycle.onWorkerHealth).toHaveBeenCalled();
  });

  it('shutdown handler saves clean status and acks', async () => {
    let shutdownCallback: (() => Promise<void>) | null = null;
    (window.duckspace.lifecycle.onShutdownPrepare as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => Promise<void>) => {
        shutdownCallback = cb;
        return () => {};
      },
    );
    (window.duckspace.lifecycle.shutdownAck as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    await runBootstrap();
    expect(shutdownCallback).not.toBeNull();

    await shutdownCallback!();

    expect(mockAppStatePut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shutdown_status', value: 'clean' }),
    );
    expect(window.duckspace.lifecycle.shutdownAck).toHaveBeenCalled();
  });

  it('shutdown handler acks even on error', async () => {
    let shutdownCallback: (() => Promise<void>) | null = null;
    (window.duckspace.lifecycle.onShutdownPrepare as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => Promise<void>) => {
        shutdownCallback = cb;
        return () => {};
      },
    );
    (window.duckspace.lifecycle.shutdownAck as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    await runBootstrap();
    // Make app_state.put throw during shutdown
    mockAppStatePut.mockRejectedValue(new Error('db error'));
    await shutdownCallback!();

    expect(window.duckspace.lifecycle.shutdownAck).toHaveBeenCalled();
  });

  it('shutdown handler saves last active tab', async () => {
    let shutdownCallback: (() => Promise<void>) | null = null;
    (window.duckspace.lifecycle.onShutdownPrepare as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: () => Promise<void>) => {
        shutdownCallback = cb;
        return () => {};
      },
    );
    (window.duckspace.lifecycle.shutdownAck as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    // Need to mock db.tabs.filter for the shutdown handler
    const mockFilter = vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue({ id: 'active-tab-id', active: true }),
    });
    const dbModule = await import('@renderer/stores/db');
    (dbModule.db as any).tabs.filter = mockFilter;

    await runBootstrap();
    await shutdownCallback!();

    expect(mockAppStatePut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'last_active_tab_id', value: 'active-tab-id' }),
    );
  });

  it('bounds handler saves bounds to db', async () => {
    let boundsCallback:
      | ((bounds: { x: number; y: number; width: number; height: number }) => Promise<void>)
      | null = null;
    (window.duckspace.lifecycle.onBoundsChanged as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>) => {
        boundsCallback = cb;
        return () => {};
      },
    );

    await runBootstrap();
    expect(boundsCallback).not.toBeNull();

    await boundsCallback!({ x: 100, y: 200, width: 1280, height: 800 });

    expect(mockAppStatePut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'window_bounds',
        value: { x: 100, y: 200, width: 1280, height: 800 },
      }),
    );
  });

  it('query history handler saves record to db', async () => {
    let queryHistoryCallback: ((record: any) => Promise<void>) | null = null;
    (window.duckspace.query.onQueryHistory as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (record: any) => Promise<void>) => {
        queryHistoryCallback = cb;
        return () => {};
      },
    );

    await runBootstrap();
    expect(queryHistoryCallback).not.toBeNull();

    await queryHistoryCallback!({
      queryId: 'q-1',
      sql: 'SELECT 1',
      executionTimeMs: 42,
      rowCount: 1,
      status: 'success',
    });

    expect(mockQueryHistoryPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'q-1',
        sql: 'SELECT 1',
        executionTimeMs: 42,
        status: 'success',
      }),
    );
  });

  it('worker health handler saves health to db', async () => {
    let workerHealthCallback: ((health: any) => Promise<void>) | null = null;
    (window.duckspace.lifecycle.onWorkerHealth as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (health: any) => Promise<void>) => {
        workerHealthCallback = cb;
        return () => {};
      },
    );

    await runBootstrap();
    expect(workerHealthCallback).not.toBeNull();

    await workerHealthCallback!({
      worker: 'duckdb',
      status: 'ready',
      restartCount: 0,
    });

    expect(mockWorkerHealthPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'duckdb',
        status: 'ready',
        restartCount: 0,
      }),
    );
  });
});
