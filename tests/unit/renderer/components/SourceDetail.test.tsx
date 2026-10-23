// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSource, mockColumnStats, mockTransaction, mockBulkAdd, mockGetColumnStats } =
  vi.hoisted(() => ({
    mockSource: { current: undefined as any },
    mockColumnStats: { current: undefined as any[] | undefined },
    mockTransaction: vi.fn((_mode: string, _table: unknown, fn: () => unknown) => fn()),
    mockBulkAdd: vi.fn(),
    mockGetColumnStats: vi.fn(),
  }));

vi.mock('@renderer/stores/hooks', () => ({
  useDataSource: vi.fn(() => mockSource.current),
  useColumnStats: vi.fn(() => mockColumnStats.current),
}));

vi.mock('@renderer/stores/db', () => ({
  db: {
    column_statistics: {
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({ delete: vi.fn() }),
      }),
      bulkAdd: mockBulkAdd,
    },
    transaction: mockTransaction,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSource.current = undefined;
  mockColumnStats.current = undefined;
  Object.defineProperty(window, 'duckspace', {
    value: {
      catalog: { getColumnStats: mockGetColumnStats },
    },
    writable: true,
    configurable: true,
  });
});

import { SourceDetail } from '@renderer/components/SourceDetail';

describe('SourceDetail', () => {
  it('renders loading state when source is undefined', () => {
    mockSource.current = undefined;
    render(<SourceDetail dataSourceId="ds-1" />);
    expect(screen.getByText('Loading source details...')).toBeDefined();
  });

  it('renders source name and status badge', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'active',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [];
    render(<SourceDetail dataSourceId="ds-1" />);
    expect(screen.getByText('test.csv')).toBeDefined();
    expect(screen.getByText('active')).toBeDefined();
    expect(screen.getByText('CSV')).toBeDefined();
  });

  it('renders file path, row count, and column count', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'active',
      rowCount: 1000,
      columnCount: 10,
      fileSizeBytes: 4096,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [];
    render(<SourceDetail dataSourceId="ds-1" />);
    expect(screen.getByText('/data/test.csv')).toBeDefined();
    expect(screen.getByText((1000).toLocaleString())).toBeDefined();
    expect(screen.getByText((10).toLocaleString())).toBeDefined();
    expect(screen.getByText('4.0 KB')).toBeDefined();
  });

  it('renders dash for missing row/column counts', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'parquet',
      status: 'importing',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [];
    render(<SourceDetail dataSourceId="ds-1" />);
    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('renders Compute Stats button', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'active',
      duckdbTableName: 'test_csv',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [];
    render(<SourceDetail dataSourceId="ds-1" />);
    expect(screen.getByText('Column Statistics')).toBeDefined();
  });

  it('shows Recompute when stats already exist', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'active',
      duckdbTableName: 'test_csv',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [
      {
        id: 'ds1__col1',
        dataSourceId: 'ds-1',
        columnName: 'col1',
        columnType: 'INTEGER',
        rowCount: 100,
        nullCount: 0,
        nullPercentage: 0,
        distinctCount: 100,
        computedAt: '2024-01-01T00:00:00Z',
      },
    ];
    render(<SourceDetail dataSourceId="ds-1" />);
    expect(screen.getByText('Recompute')).toBeDefined();
  });

  it('renders empty stats message when no stats exist', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'error',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [];
    render(<SourceDetail dataSourceId="ds-1" />);
    expect(screen.getByText(/No statistics computed yet/)).toBeDefined();
  });

  it('renders all format labels correctly', () => {
    const formats = [
      { format: 'csv', label: 'CSV' },
      { format: 'tsv', label: 'TSV' },
      { format: 'parquet', label: 'Parquet' },
      { format: 'json', label: 'JSON' },
      { format: 'jsonl', label: 'JSONL' },
      { format: 'xlsx', label: 'Excel' },
      { format: 'arrow_ipc', label: 'Arrow IPC' },
    ];

    for (const { format, label } of formats) {
      mockSource.current = {
        id: 'ds-1',
        name: 'test',
        filePath: '/test',
        format,
        status: 'active',
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      mockColumnStats.current = [];
      const { unmount } = render(<SourceDetail dataSourceId="ds-1" />);
      expect(screen.getByText(label)).toBeDefined();
      unmount();
    }
  });

  it('formats file sizes correctly', () => {
    const testCases = [
      { bytes: 512, expected: '512 B' },
      { bytes: 2048, expected: '2.0 KB' },
      { bytes: 1_500_000, expected: '1.4 MB' },
      { bytes: 2_000_000_000, expected: '1.9 GB' },
    ];

    for (const { bytes, expected } of testCases) {
      mockSource.current = {
        id: 'ds-1',
        name: 'test',
        filePath: '/test',
        format: 'csv',
        status: 'active',
        fileSizeBytes: bytes,
        tags: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      mockColumnStats.current = [];
      const { unmount } = render(<SourceDetail dataSourceId="ds-1" />);
      expect(screen.getByText(expected)).toBeDefined();
      unmount();
    }
  });

  it('calls getColumnStats when compute button is clicked', async () => {
    mockGetColumnStats.mockResolvedValue({
      columns: [],
      computedAt: '2024-01-01T00:00:00Z',
      durationMs: 100,
    });
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'active',
      duckdbTableName: 'test_csv',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [
      {
        id: 'ds1__col1',
        dataSourceId: 'ds-1',
        columnName: 'col1',
        columnType: 'INTEGER',
        rowCount: 100,
        nullCount: 0,
        nullPercentage: 0,
        distinctCount: 100,
        computedAt: '2024-01-01T00:00:00Z',
      },
    ];
    render(<SourceDetail dataSourceId="ds-1" />);
    const button = screen.getByText('Recompute');
    fireEvent.click(button);
    await waitFor(() => {
      expect(mockGetColumnStats).toHaveBeenCalledWith('ds-1', true, 'test_csv');
    });
  });

  it('disables compute button when source is not active', () => {
    mockSource.current = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv',
      status: 'error',
      duckdbTableName: 'test_csv',
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    mockColumnStats.current = [];
    render(<SourceDetail dataSourceId="ds-1" />);
    const buttons = screen.getAllByRole('button');
    const computeButton = buttons.find((b) => b.textContent?.includes('Compute'));
    expect(computeButton).toBeDefined();
    expect((computeButton as HTMLButtonElement).disabled).toBe(true);
  });
});
