// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Polyfill ResizeObserver for jsdom
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

// We use a shared mutable ref that the mock factory can capture
// vi.hoisted ensures these are available when vi.mock factories run
const { mockMergeBatchesReturn } = vi.hoisted(() => {
  return {
    mockMergeBatchesReturn: { current: null as any },
  };
});

vi.mock('@renderer/lib/arrow-decode', () => ({
  decodeArrowBatch: vi.fn().mockReturnValue({
    columns: ['id', 'name'],
    columnTypes: ['Int32', 'Utf8'],
    rowCount: 0,
    byteSize: 0,
    getColumn: vi.fn(),
    getCell: vi.fn(),
  }),
  mergeBatches: vi.fn(() => mockMergeBatchesReturn.current),
}));

import { ResultGrid } from '@renderer/components/ResultGrid';

describe('ResultGrid', () => {
  beforeEach(() => {
    mockMergeBatchesReturn.current = null;
    vi.clearAllMocks();
  });

  it('renders empty state "Execute a query to see results" when queryId is null', () => {
    render(<ResultGrid queryId={null} />);
    expect(screen.getByText('Execute a query to see results')).toBeDefined();
  });

  it('shows table when merged data is available', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id', 'name'],
      columnTypes: ['Int32', 'Utf8'],
      rowCount: 3,
      byteSize: 128,
      getColumn: vi.fn(),
      getCell: vi.fn((row: number, col: number) => {
        const data = [
          [1, 'Alice'],
          [2, 'Bob'],
          [3, 'Carol'],
        ];
        return data[row]?.[col] ?? null;
      }),
    };
    render(<ResultGrid queryId="q-1" />);
    // Column headers should be rendered
    expect(screen.getByText('id')).toBeDefined();
    expect(screen.getByText('name')).toBeDefined();
  });

  it('shows column types in header', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id', 'name'],
      columnTypes: ['Int32', 'Utf8'],
      rowCount: 3,
      byteSize: 128,
      getColumn: vi.fn(),
      getCell: vi.fn(),
    };
    render(<ResultGrid queryId="q-1" />);
    expect(screen.getByText('Int32')).toBeDefined();
    expect(screen.getByText('Utf8')).toBeDefined();
  });

  it('row count footer shows correct count', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id', 'name'],
      columnTypes: ['Int32', 'Utf8'],
      rowCount: 3,
      byteSize: 128,
      getColumn: vi.fn(),
      getCell: vi.fn(),
    };
    render(<ResultGrid queryId="q-1" />);
    expect(screen.getByText('3 rows')).toBeDefined();
  });

  it('row count footer shows singular "row" for 1 row', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id'],
      columnTypes: ['Int32'],
      rowCount: 1,
      byteSize: 64,
      getColumn: vi.fn(),
      getCell: vi.fn(),
    };
    render(<ResultGrid queryId="q-1" />);
    expect(screen.getByText('1 row')).toBeDefined();
  });

  it('does not show table when no merged data and queryId is set', () => {
    mockMergeBatchesReturn.current = null;
    render(<ResultGrid queryId="q-1" />);
    // queryId is set but no batches yet, so neither empty state nor table
    expect(screen.queryByText('Execute a query to see results')).toBeNull();
  });

  it('renders NULL for null cell values', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id', 'name'],
      columnTypes: ['Int32', 'Utf8'],
      rowCount: 1,
      byteSize: 64,
      getColumn: vi.fn(),
      getCell: vi.fn((_row: number, col: number) => {
        if (col === 1) return null;
        return 1;
      }),
    };
    render(<ResultGrid queryId="q-1" />);
    expect(screen.getByText('NULL')).toBeDefined();
  });

  it('renders cell values correctly', () => {
    mockMergeBatchesReturn.current = {
      columns: ['id', 'name'],
      columnTypes: ['Int32', 'Utf8'],
      rowCount: 2,
      byteSize: 128,
      getColumn: vi.fn(),
      getCell: vi.fn((row: number, col: number) => {
        const data = [
          [42, 'Alice'],
          [99, 'Bob'],
        ];
        return data[row]?.[col] ?? null;
      }),
    };
    render(<ResultGrid queryId="q-1" />);
    expect(screen.getByText('42')).toBeDefined();
    expect(screen.getByText('Alice')).toBeDefined();
  });

  it('handles row hover events', async () => {
    const { fireEvent } = await import('@testing-library/react');
    mockMergeBatchesReturn.current = {
      columns: ['id'],
      columnTypes: ['Int32'],
      rowCount: 1,
      byteSize: 32,
      getColumn: vi.fn(),
      getCell: vi.fn(() => 1),
    };
    render(<ResultGrid queryId="q-1" />);
    const row = screen.getByText('1').closest('tr');
    if (row) {
      fireEvent.mouseEnter(row);
      expect(row.style.backgroundColor).toBe('rgb(249, 250, 251)');
      fireEvent.mouseLeave(row);
      expect(row.style.backgroundColor).toBe('');
    }
  });
});
