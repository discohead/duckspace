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

    // The dispatched event detail should have { queryId, batch }, not just batch
    expect(capturedEvents.length).toBeGreaterThan(0);
    const detail = capturedEvents[0]!.detail;
    expect(detail).toHaveProperty('queryId');
    expect(detail).toHaveProperty('batch');
    expect(detail.queryId).toBe('q-123');
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

  // #6/#7: ResultGrid must receive a non-null queryId
  it('passes activeTab.id as queryId to ResultGrid, not null (#6/#7)', () => {
    render(<App />);

    // The ResultGrid should NOT be showing "Execute a query to see results"
    // when we have an active query tab (because queryId should be "tab-1", not null)
    // If it IS showing "Execute a query...", that means queryId is null (the bug)
    //
    // NOTE: When queryId is set but no batches, ResultGrid shows neither
    // the empty state nor data. When queryId is null AND no batches,
    // it shows "Execute a query to see results".
    //
    // If the bug exists (queryId=null), the empty message appears.
    // If fixed (queryId="tab-1"), the empty message does NOT appear.
    expect(screen.queryByText('Execute a query to see results')).toBeNull();
  });
});
