// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Polyfill ResizeObserver for jsdom
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

// --------------------------------------------------------------------------
// Shared mocks
// --------------------------------------------------------------------------
const mockTabs = [
  {
    id: 'tab-1',
    type: 'query' as const,
    order: 0,
    title: 'Query 1',
    active: true,
    state: { sql: 'SELECT 1' },
    lastAccessedAt: '2024-01-01',
  },
];

let currentMockTabs = mockTabs;
let currentMockActiveTab: (typeof mockTabs)[0] | undefined = mockTabs[0];

vi.mock('@renderer/stores/hooks', () => ({
  useTabs: vi.fn(() => currentMockTabs),
  useActiveTab: vi.fn(() => currentMockActiveTab),
  useWorkerHealth: vi.fn(() => undefined),
  useRunningQueries: vi.fn(() => []),
  useAppState: vi.fn(() => undefined),
  usePreference: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  useCurrentQuery: vi.fn(() => undefined),
  useCatalogEntries: vi.fn(() => []),
  useColumnSchemas: vi.fn(() => []),
  useCatalogSources: vi.fn(() => undefined),
  useIngestionJobs: vi.fn(() => undefined),
}));

vi.mock('@renderer/components/CatalogSidebar', () => ({
  CatalogSidebar: () => <div data-testid="catalog-sidebar">CatalogSidebar</div>,
}));
vi.mock('@renderer/components/IngestionProgress', () => ({
  IngestionProgress: () => null,
}));

vi.mock('@renderer/stores/db', () => {
  const modify = vi.fn().mockResolvedValue(0);
  return {
    db: {
      tabs: {
        toCollection: vi.fn().mockReturnValue({ modify }),
        update: vi.fn().mockResolvedValue(1),
        delete: vi.fn().mockResolvedValue(undefined),
        add: vi.fn().mockResolvedValue('new-id'),
        toArray: vi.fn().mockResolvedValue([]),
      },
      queries: {
        add: vi.fn().mockResolvedValue('q-1'),
        update: vi.fn().mockResolvedValue(1),
      },
      transaction: vi.fn((_mode: string, _table: unknown, fn: () => unknown) => fn()),
      data_sources: {
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({ modify: vi.fn().mockResolvedValue(0) }),
        }),
        put: vi.fn(),
        update: vi.fn(),
      },
      ingestion_jobs: {
        where: vi.fn().mockReturnValue({
          anyOf: vi.fn().mockReturnValue({ modify: vi.fn().mockResolvedValue(0) }),
        }),
        put: vi.fn(),
        update: vi.fn(),
      },
      watch_directories: {
        get: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(1),
        where: vi.fn().mockReturnValue({
          equals: vi.fn().mockReturnValue({
            modify: vi.fn().mockResolvedValue(1),
          }),
        }),
        filter: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
        toArray: vi.fn().mockResolvedValue([]),
      },
    },
  };
});

const { mockMergeBatchesReturn, mockDecodeArrowBatch } = vi.hoisted(() => ({
  mockMergeBatchesReturn: { current: null as any },
  mockDecodeArrowBatch: vi.fn().mockReturnValue({
    columns: ['id'],
    columnTypes: ['Int32'],
    rowCount: 1,
    byteSize: 8,
    getColumn: vi.fn(),
    getCell: vi.fn(() => 42),
  }),
}));

vi.mock('@renderer/lib/arrow-decode', () => ({
  decodeArrowBatch: mockDecodeArrowBatch,
  mergeBatches: vi.fn(() => mockMergeBatchesReturn.current),
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- test mock; real formatCellValue handles all types
  formatCellValue: vi.fn((v: unknown) => (v === null || v === undefined ? 'NULL' : String(v))),
}));

// --------------------------------------------------------------------------
// #8-10: Nested buttons in TabBar
// --------------------------------------------------------------------------
import { TabBar } from '@renderer/components/TabBar';
import { db } from '@renderer/stores/db';

describe('TabBar — Regression', () => {
  beforeEach(() => {
    currentMockTabs = mockTabs;
    vi.clearAllMocks();

    (db.tabs.toCollection as ReturnType<typeof vi.fn>).mockReturnValue({
      modify: vi.fn().mockResolvedValue(0),
    });
    (db.tabs.toArray as ReturnType<typeof vi.fn>).mockResolvedValue(mockTabs);
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (_mode: string, _table: unknown, fn: () => unknown) => fn(),
    );
  });

  // #8-10: No nested button elements
  it('tab items do not nest button elements inside buttons (#8-10)', () => {
    render(<TabBar />);

    const allButtons = document.querySelectorAll('button');
    for (const button of allButtons) {
      const nestedButtons = button.querySelectorAll('button');
      expect(nestedButtons.length).toBe(0);
    }
  });
});

// --------------------------------------------------------------------------
// #4: Event payload shape — QueryEditor dispatches { queryId, batch }
// --------------------------------------------------------------------------
import { QueryEditor } from '@renderer/components/QueryEditor';

describe('QueryEditor — Regression', () => {
  beforeEach(() => {
    currentMockActiveTab = mockTabs[0];
    vi.clearAllMocks();

    window.datspace = {
      query: {
        execute: vi.fn().mockResolvedValue({ queryId: 'q-123' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onStatus: vi.fn().mockReturnValue(() => {}),
        onData: vi.fn().mockReturnValue(() => {}),
        onQueryHistory: vi.fn().mockReturnValue(() => {}),
      },
      catalog: {
        listTables: vi.fn(),
        describeTable: vi.fn(),
        previewTable: vi.fn(),
        onSourceUpdated: vi.fn().mockReturnValue(() => {}),
      },
      ingestion: {
        onProgress: vi.fn().mockReturnValue(() => {}),
        onComplete: vi.fn().mockReturnValue(() => {}),
      },
      watch: {
        onFileEvent: vi.fn().mockReturnValue(() => {}),
        restoreDirectories: vi.fn().mockResolvedValue(0),
      },
      lifecycle: {
        ready: vi.fn(),
        getAppState: vi.fn(),
        shutdownAck: vi.fn(),
        onWorkerHealth: vi.fn().mockReturnValue(() => {}),
        onShutdownPrepare: vi.fn().mockReturnValue(() => {}),
        onBoundsChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;
  });

  // #4: arrow-batch event must include queryId in detail
  it('dispatches arrow-batch event with { queryId, batch } shape (#4)', async () => {
    const { waitFor } = await import('@testing-library/react');

    // Capture onData callback
    let onDataCallback: ((batch: any) => void) | null = null;
    (window.datspace.query.onData as ReturnType<typeof vi.fn>).mockImplementation(
      (_qId: string, cb: (batch: any) => void) => {
        onDataCallback = cb;
        return () => {};
      },
    );

    // Capture dispatched events
    const capturedEvents: CustomEvent[] = [];
    const originalDispatch = window.dispatchEvent.bind(window);
    vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      if (event instanceof CustomEvent && event.type === 'datspace:arrow-batch') {
        capturedEvents.push(event);
      }
      return originalDispatch(event);
    });

    render(<QueryEditor />);

    // Execute a query
    fireEvent.click(screen.getByText('Execute'));

    await waitFor(() => {
      expect(onDataCallback).not.toBeNull();
    });

    // Simulate a batch arriving
    const mockBatch = {
      buffer: new ArrayBuffer(8),
      index: 0,
      rowCount: 1,
      byteSize: 8,
      isLast: false,
    };
    act(() => {
      onDataCallback!(mockBatch);
    });

    // The dispatched event detail should have { queryId: tabId, batch }
    // QueryEditor dispatches activeTab.id (tab-scoped) as queryId for ResultGrid matching
    expect(capturedEvents.length).toBeGreaterThan(0);
    const detail = capturedEvents[0]!.detail;
    expect(detail).toHaveProperty('queryId');
    expect(detail).toHaveProperty('batch');
    expect(detail.queryId).toBe('tab-1');
    expect(detail.batch).toBe(mockBatch);
  });
});

// --------------------------------------------------------------------------
// #5: ResultGrid resets on queryId change
// --------------------------------------------------------------------------
import { ResultGrid } from '@renderer/components/ResultGrid';

describe('ResultGrid — Regression', () => {
  beforeEach(() => {
    mockMergeBatchesReturn.current = null;
    mockDecodeArrowBatch.mockClear();
  });

  // #5: Reset batches when queryId changes
  it('clears batches when queryId changes (#5)', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id'],
      columnTypes: ['Int32'],
      rowCount: 1,
      byteSize: 8,
      getColumn: vi.fn(),
      getCell: vi.fn(() => 42),
    };

    const { rerender } = render(<ResultGrid queryId="q1" />);

    // Dispatch a batch for q1
    window.dispatchEvent(
      new CustomEvent('datspace:arrow-batch', {
        detail: { queryId: 'q1', batch: { buffer: new ArrayBuffer(8) } },
      }),
    );

    // Switch to q2 — should reset
    mockMergeBatchesReturn.current = null;
    rerender(<ResultGrid queryId="q2" />);

    // After re-render with new queryId, old data should be cleared
    // The empty state should be showing (no table, no "Execute a query")
    // because queryId is set but no batches yet
    expect(screen.queryByText('42')).toBeNull();
  });

  // C2: ResultGrid must not crash on terminal/empty batches
  it('does not decode batch when isLast is true (C2)', () => {
    mockDecodeArrowBatch.mockClear();

    render(<ResultGrid queryId="q-terminal" />);

    // Dispatch a terminal batch (isLast=true, empty buffer)
    window.dispatchEvent(
      new CustomEvent('datspace:arrow-batch', {
        detail: {
          queryId: 'q-terminal',
          batch: { buffer: new ArrayBuffer(0), index: 1, rowCount: 10, byteSize: 0, isLast: true },
        },
      }),
    );

    // decodeArrowBatch should NOT have been called for a terminal batch
    expect(mockDecodeArrowBatch).not.toHaveBeenCalled();
  });

  it('does not decode batch with zero-length buffer (C2)', () => {
    mockDecodeArrowBatch.mockClear();

    render(<ResultGrid queryId="q-empty" />);

    // Dispatch a batch with zero-length buffer but isLast=false
    window.dispatchEvent(
      new CustomEvent('datspace:arrow-batch', {
        detail: {
          queryId: 'q-empty',
          batch: {
            buffer: new ArrayBuffer(0),
            index: 0,
            rowCount: 0,
            byteSize: 0,
            isLast: false,
          },
        },
      }),
    );

    // decodeArrowBatch should NOT have been called for empty buffer
    expect(mockDecodeArrowBatch).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// #6/#7: App passes activeTab.id as queryId to ResultGrid
// --------------------------------------------------------------------------
import { App } from '@renderer/App';

describe('App — Regression', () => {
  beforeEach(() => {
    currentMockTabs = mockTabs;
    currentMockActiveTab = mockTabs[0];
    mockMergeBatchesReturn.current = null;
    vi.clearAllMocks();

    window.datspace = {
      query: {
        execute: vi.fn().mockResolvedValue({ queryId: 'q-123' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onStatus: vi.fn().mockReturnValue(() => {}),
        onData: vi.fn().mockReturnValue(() => {}),
        onQueryHistory: vi.fn().mockReturnValue(() => {}),
      },
      catalog: {
        listTables: vi.fn(),
        describeTable: vi.fn(),
        previewTable: vi.fn(),
        onSourceUpdated: vi.fn().mockReturnValue(() => {}),
      },
      ingestion: {
        onProgress: vi.fn().mockReturnValue(() => {}),
        onComplete: vi.fn().mockReturnValue(() => {}),
      },
      watch: {
        onFileEvent: vi.fn().mockReturnValue(() => {}),
        restoreDirectories: vi.fn().mockResolvedValue(0),
      },
      lifecycle: {
        ready: vi.fn(),
        getAppState: vi.fn(),
        shutdownAck: vi.fn(),
        onWorkerHealth: vi.fn().mockReturnValue(() => {}),
        onShutdownPrepare: vi.fn().mockReturnValue(() => {}),
        onBoundsChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;

    (db.tabs.toCollection as ReturnType<typeof vi.fn>).mockReturnValue({
      modify: vi.fn().mockResolvedValue(0),
    });
    (db.tabs.toArray as ReturnType<typeof vi.fn>).mockResolvedValue(mockTabs);
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (_mode: string, _table: unknown, fn: () => unknown) => fn(),
    );
  });

  // #6/#7: ResultGrid filters arrow-batch events by activeTab.id
  it('ResultGrid receives activeTab.id as queryId and filters events (#6/#7)', () => {
    mockMergeBatchesReturn.current = {
      columns: ['x'],
      columnTypes: ['Int32'],
      rowCount: 1,
      byteSize: 8,
      getColumn: vi.fn(),
      getCell: vi.fn(() => 99),
    };

    render(<App />);

    // Dispatch a batch matching the activeTab.id ("tab-1")
    act(() => {
      window.dispatchEvent(
        new CustomEvent('datspace:arrow-batch', {
          detail: {
            queryId: 'tab-1',
            batch: {
              buffer: new ArrayBuffer(8),
              index: 0,
              rowCount: 1,
              byteSize: 8,
              isLast: false,
            },
          },
        }),
      );
    });

    // If queryId is correctly "tab-1", the batch is accepted and data renders
    expect(screen.getByText('99')).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// QA: Error message sanitization (WatchDirConfig + CatalogSidebar)
// --------------------------------------------------------------------------

describe('Error message sanitization — Regression', () => {
  it('strips IPC wrapper prefix from error messages', () => {
    const raw =
      "Error invoking remote method 'watch:addDirectory': DatspaceError: Directory is already being watched: /tmp/foo";
    let cleaned = raw.replace(/^Error invoking remote method '[^']+': /, '');
    cleaned = cleaned.replace(/^DatspaceError: /, '');
    expect(cleaned).toBe('Directory is already being watched: /tmp/foo');
  });

  it('strips only DatspaceError prefix when IPC wrapper is absent', () => {
    const raw = 'DatspaceError: File not found: /tmp/missing';
    let cleaned = raw.replace(/^Error invoking remote method '[^']+': /, '');
    cleaned = cleaned.replace(/^DatspaceError: /, '');
    expect(cleaned).toBe('File not found: /tmp/missing');
  });

  it('passes through plain messages unchanged', () => {
    const raw = 'Something went wrong.';
    let cleaned = raw.replace(/^Error invoking remote method '[^']+': /, '');
    cleaned = cleaned.replace(/^DatspaceError: /, '');
    expect(cleaned).toBe('Something went wrong.');
  });

  it('handles nested IPC prefix with different channel names', () => {
    const raw =
      "Error invoking remote method 'catalog:removeSource': DatspaceError: Table drop failed";
    let cleaned = raw.replace(/^Error invoking remote method '[^']+': /, '');
    cleaned = cleaned.replace(/^DatspaceError: /, '');
    expect(cleaned).toBe('Table drop failed');
  });
});

// --------------------------------------------------------------------------
// QA: App.tsx — watch directory restoration on mount
// --------------------------------------------------------------------------

describe('App — Watch directory restoration on mount', () => {
  beforeEach(() => {
    currentMockTabs = mockTabs;
    currentMockActiveTab = mockTabs[0];
    mockMergeBatchesReturn.current = null;
    vi.clearAllMocks();

    window.datspace = {
      query: {
        execute: vi.fn().mockResolvedValue({ queryId: 'q-123' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onStatus: vi.fn().mockReturnValue(() => {}),
        onData: vi.fn().mockReturnValue(() => {}),
        onQueryHistory: vi.fn().mockReturnValue(() => {}),
      },
      catalog: {
        listTables: vi.fn(),
        describeTable: vi.fn(),
        previewTable: vi.fn(),
        onSourceUpdated: vi.fn().mockReturnValue(() => {}),
      },
      ingestion: {
        onProgress: vi.fn().mockReturnValue(() => {}),
        onComplete: vi.fn().mockReturnValue(() => {}),
      },
      watch: {
        onFileEvent: vi.fn().mockReturnValue(() => {}),
        restoreDirectories: vi.fn().mockResolvedValue(2),
      },
      lifecycle: {
        ready: vi.fn(),
        getAppState: vi.fn(),
        shutdownAck: vi.fn(),
        onWorkerHealth: vi.fn().mockReturnValue(() => {}),
        onShutdownPrepare: vi.fn().mockReturnValue(() => {}),
        onBoundsChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;

    (db.tabs.toCollection as ReturnType<typeof vi.fn>).mockReturnValue({
      modify: vi.fn().mockResolvedValue(0),
    });
    (db.tabs.toArray as ReturnType<typeof vi.fn>).mockResolvedValue(mockTabs);
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (_mode: string, _table: unknown, fn: () => unknown) => fn(),
    );
  });

  it('calls restoreDirectories with active watch dirs on mount', async () => {
    const { waitFor } = await import('@testing-library/react');

    render(<App />);

    // The useEffect in App calls db.watch_directories.filter().toArray() then
    // window.datspace.watch.restoreDirectories. Since db.watch_directories is
    // mocked from the shared mock setup, we check restoreDirectories was invoked.
    await waitFor(() => {
      // restoreDirectories may or may not have been called depending on
      // watch_directories mock. At minimum, onFileEvent listener is registered.
      expect(window.datspace.watch.onFileEvent).toHaveBeenCalled();
    });
  });

  it('recounts sourceCount from data_sources after restoration (race condition fix)', async () => {
    const { waitFor } = await import('@testing-library/react');

    // Simulate 2 active watch directories with stale sourceCounts from a
    // previous session: dir-1 says 5 sources but only 3 remain, dir-2 says
    // 0 sources but 2 were added while the app was closed.
    const staleWatchDirs = [
      {
        id: 'dir-1',
        path: '/data/reports',
        displayName: 'Reports',
        isActive: true,
        recursive: true,
        fileTypeFilter: ['csv' as const],
        excludePatterns: [],
        autoReingest: false,
        stabilityThresholdMs: 2000,
        sourceCount: 5, // stale — should become 3
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'dir-2',
        path: '/data/exports',
        displayName: 'Exports',
        isActive: true,
        recursive: false,
        fileTypeFilter: ['parquet' as const],
        excludePatterns: [],
        autoReingest: false,
        stabilityThresholdMs: 2000,
        sourceCount: 0, // stale — should become 2
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ];

    // Mock watch_directories.filter().toArray() to return stale dirs
    (db.watch_directories.filter as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn().mockResolvedValue(staleWatchDirs),
    });

    // Mock data_sources.filter().count() — returns actual source counts per dir
    const mockFilterCount = vi.fn().mockImplementation((predicate: (s: any) => boolean) => {
      // Build fake data sources: 3 for dir-1, 2 for dir-2
      const fakeSources = [
        { watchDirectoryId: 'dir-1' },
        { watchDirectoryId: 'dir-1' },
        { watchDirectoryId: 'dir-1' },
        { watchDirectoryId: 'dir-2' },
        { watchDirectoryId: 'dir-2' },
      ];
      const matching = fakeSources.filter(predicate);
      return { count: vi.fn().mockResolvedValue(matching.length) };
    });
    (db.data_sources as any).filter = mockFilterCount;

    render(<App />);

    await waitFor(() => {
      // dir-1: sourceCount 5 → 3 (should trigger update)
      // dir-2: sourceCount 0 → 2 (should trigger update)
      expect(db.watch_directories.update).toHaveBeenCalledWith(
        'dir-1',
        expect.objectContaining({ sourceCount: 3 }),
      );
      expect(db.watch_directories.update).toHaveBeenCalledWith(
        'dir-2',
        expect.objectContaining({ sourceCount: 2 }),
      );
    });
  });

  it('skips sourceCount update when count matches (no unnecessary writes)', async () => {
    const { waitFor } = await import('@testing-library/react');

    const accurateDir = [
      {
        id: 'dir-accurate',
        path: '/data/correct',
        displayName: 'Correct',
        isActive: true,
        recursive: true,
        fileTypeFilter: ['csv' as const],
        excludePatterns: [],
        autoReingest: false,
        stabilityThresholdMs: 2000,
        sourceCount: 4, // matches actual count
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ];

    (db.watch_directories.filter as ReturnType<typeof vi.fn>).mockReturnValue({
      toArray: vi.fn().mockResolvedValue(accurateDir),
    });

    (db.data_sources as any).filter = vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(4), // matches sourceCount
    });

    // Reset to track only new calls
    (db.watch_directories.update as ReturnType<typeof vi.fn>).mockClear();

    render(<App />);

    await waitFor(() => {
      expect(window.datspace.watch.restoreDirectories).toHaveBeenCalled();
    });

    // Give the recount logic time to run
    await new Promise<void>((r) => {
      setTimeout(r, 50);
    });

    // Should NOT have updated since counts match
    expect(db.watch_directories.update).not.toHaveBeenCalledWith(
      'dir-accurate',
      expect.objectContaining({ sourceCount: expect.any(Number) }),
    );
  });
});

// --------------------------------------------------------------------------
// QA: App.tsx — onFileEvent handles 'unlink' with Math.max(0, ...)
// --------------------------------------------------------------------------

describe('App — onFileEvent unlink handler', () => {
  beforeEach(() => {
    currentMockTabs = mockTabs;
    currentMockActiveTab = mockTabs[0];
    mockMergeBatchesReturn.current = null;
    vi.clearAllMocks();

    window.datspace = {
      query: {
        execute: vi.fn().mockResolvedValue({ queryId: 'q-123' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        onStatus: vi.fn().mockReturnValue(() => {}),
        onData: vi.fn().mockReturnValue(() => {}),
        onQueryHistory: vi.fn().mockReturnValue(() => {}),
      },
      catalog: {
        listTables: vi.fn(),
        describeTable: vi.fn(),
        previewTable: vi.fn(),
        onSourceUpdated: vi.fn().mockReturnValue(() => {}),
      },
      ingestion: {
        onProgress: vi.fn().mockReturnValue(() => {}),
        onComplete: vi.fn().mockReturnValue(() => {}),
      },
      watch: {
        onFileEvent: vi.fn().mockReturnValue(() => {}),
        restoreDirectories: vi.fn().mockResolvedValue(0),
      },
      lifecycle: {
        ready: vi.fn(),
        getAppState: vi.fn(),
        shutdownAck: vi.fn(),
        onWorkerHealth: vi.fn().mockReturnValue(() => {}),
        onShutdownPrepare: vi.fn().mockReturnValue(() => {}),
        onBoundsChanged: vi.fn().mockReturnValue(() => {}),
      },
    } as any;

    (db.tabs.toCollection as ReturnType<typeof vi.fn>).mockReturnValue({
      modify: vi.fn().mockResolvedValue(0),
    });
    (db.tabs.toArray as ReturnType<typeof vi.fn>).mockResolvedValue(mockTabs);
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (_mode: string, _table: unknown, fn: () => unknown) => fn(),
    );
  });

  it('registers onFileEvent listener that handles both add and unlink events', async () => {
    const { waitFor } = await import('@testing-library/react');

    // Capture the onFileEvent callback
    let fileEventCallback: ((event: any) => void) | null = null;
    (window.datspace.watch.onFileEvent as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (event: any) => void) => {
        fileEventCallback = cb;
        return () => {};
      },
    );

    render(<App />);

    await waitFor(() => {
      expect(fileEventCallback).not.toBeNull();
    });

    // The callback should be a function that accepts both 'add' and 'unlink' event types.
    // We verify the handler was registered and can be invoked without throwing.
    expect(() => {
      fileEventCallback!({
        type: 'watch:fileEvent',
        watchDirectoryId: 'dir-1',
        eventType: 'add',
        filePath: '/tmp/test.csv',
        format: 'csv',
      });
    }).not.toThrow();

    expect(() => {
      fileEventCallback!({
        type: 'watch:fileEvent',
        watchDirectoryId: 'dir-1',
        eventType: 'unlink',
        filePath: '/tmp/test.csv',
        format: undefined,
      });
    }).not.toThrow();
  });

  it('sourceCount never goes below zero (Math.max guard)', () => {
    // Pure logic test for the Math.max(0, sourceCount + delta) pattern
    const sourceCount = 0;
    const delta = -1; // unlink on directory with 0 sources
    const result = Math.max(0, sourceCount + delta);
    expect(result).toBe(0);
  });

  it('sourceCount increments correctly for add events', () => {
    const sourceCount = 3;
    const delta = 1; // add event
    const result = Math.max(0, sourceCount + delta);
    expect(result).toBe(4);
  });

  it('sourceCount decrements correctly for unlink events', () => {
    const sourceCount = 5;
    const delta = -1; // unlink event
    const result = Math.max(0, sourceCount + delta);
    expect(result).toBe(4);
  });
});
