// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockJobs = vi.hoisted(() => ({
  current: null as any[] | null,
}));

vi.mock('@renderer/stores/hooks', () => ({
  useIngestionJobs: vi.fn(() => mockJobs.current),
}));

// Mock window.duckspace.ingestion.cancelJob
const mockCancelJob = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('duckspace', {
    ingestion: { cancelJob: mockCancelJob },
  });
  Object.defineProperty(window, 'duckspace', {
    value: { ingestion: { cancelJob: mockCancelJob } },
    writable: true,
    configurable: true,
  });
});

import { IngestionProgress } from '@renderer/components/IngestionProgress';

describe('IngestionProgress', () => {
  it('returns null when no active jobs', () => {
    mockJobs.current = [];
    const { container } = render(<IngestionProgress />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when jobs is null', () => {
    mockJobs.current = null;
    const { container } = render(<IngestionProgress />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when all jobs are completed', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'completed',
        filePath: '/data/test.csv',
        rowsProcessed: 1000,
        bytesProcessed: 4096,
        startedAt: '2024-01-01T00:00:00Z',
      },
    ];
    const { container } = render(<IngestionProgress />);
    expect(container.innerHTML).toBe('');
  });

  it('renders running job with file name', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 500,
        bytesProcessed: 2048,
        startedAt: new Date().toISOString(),
        estimatedTotalRows: 1000,
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText('test.csv')).toBeDefined();
  });

  it('renders progress percentage when estimatedTotalRows is available', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 500,
        bytesProcessed: 2048,
        startedAt: new Date().toISOString(),
        estimatedTotalRows: 1000,
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText('50%')).toBeDefined();
  });

  it('caps progress at 99%', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 1000,
        bytesProcessed: 4096,
        startedAt: new Date().toISOString(),
        estimatedTotalRows: 1000,
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText('99%')).toBeDefined();
  });

  it('renders progressbar with aria attributes', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/path/to/data.parquet',
        rowsProcessed: 250,
        bytesProcessed: 1024,
        startedAt: new Date().toISOString(),
        estimatedTotalRows: 1000,
      },
    ];
    render(<IngestionProgress />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeDefined();
    expect(progressbar.getAttribute('aria-valuenow')).toBe('25');
    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');
    expect(progressbar.getAttribute('aria-label')).toBe('Importing data.parquet');
  });

  it('renders cancel button', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 0,
        bytesProcessed: 0,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText('Cancel')).toBeDefined();
  });

  it('calls cancelJob on cancel click and disables button', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 0,
        bytesProcessed: 0,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);
    expect(mockCancelJob).toHaveBeenCalledWith('j1');
    // Button text changes to "Cancelling..."
    expect(screen.getByText('Cancelling...')).toBeDefined();
  });

  it('renders queued jobs too', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'queued',
        filePath: '/data/queued.csv',
        rowsProcessed: 0,
        bytesProcessed: 0,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText('queued.csv')).toBeDefined();
  });

  it('renders multiple running jobs', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/file1.csv',
        rowsProcessed: 100,
        bytesProcessed: 512,
        startedAt: new Date().toISOString(),
      },
      {
        id: 'j2',
        status: 'running',
        filePath: '/data/file2.parquet',
        rowsProcessed: 200,
        bytesProcessed: 1024,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText('file1.csv')).toBeDefined();
    expect(screen.getByText('file2.parquet')).toBeDefined();
  });

  it('formats bytes as KB', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 100,
        bytesProcessed: 2048,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText(/2\.0 KB/)).toBeDefined();
  });

  it('formats bytes as MB', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 100,
        bytesProcessed: 1_500_000,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText(/1\.4 MB/)).toBeDefined();
  });

  it('formats bytes as B for small values', () => {
    mockJobs.current = [
      {
        id: 'j1',
        status: 'running',
        filePath: '/data/test.csv',
        rowsProcessed: 1,
        bytesProcessed: 512,
        startedAt: new Date().toISOString(),
      },
    ];
    render(<IngestionProgress />);
    expect(screen.getByText(/512 B/)).toBeDefined();
  });
});
