// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockWorkerHealth:
  | {
      id: string;
      status: string;
      restartCount: number;
      lastHeartbeatAt: string;
      upSince: string;
      activeQueryCount: number;
    }
  | undefined = {
  id: 'duckdb',
  status: 'ready',
  restartCount: 0,
  lastHeartbeatAt: '',
  upSince: '',
  activeQueryCount: 0,
};

let mockRunningQueries: { id: string; status: string }[] = [];
let mockRecoveryTriggered: boolean | undefined;

vi.mock('@renderer/stores/hooks', () => ({
  useWorkerHealth: vi.fn(() => mockWorkerHealth),
  useRunningQueries: vi.fn(() => mockRunningQueries),
  useAppState: vi.fn(() => mockRecoveryTriggered),
}));

vi.mock('@renderer/stores/db', () => ({
  db: {
    app_state: { put: vi.fn().mockResolvedValue(undefined) },
  },
}));

import { StatusBar } from '@renderer/components/StatusBar';

describe('StatusBar', () => {
  beforeEach(() => {
    mockWorkerHealth = {
      id: 'duckdb',
      status: 'ready',
      restartCount: 0,
      lastHeartbeatAt: '',
      upSince: '',
      activeQueryCount: 0,
    };
    mockRunningQueries = [];
    mockRecoveryTriggered = undefined;
  });

  it('renders "DuckDB: ready" status text', () => {
    render(<StatusBar />);
    expect(screen.getByText('DuckDB: ready')).toBeDefined();
  });

  it('renders "DuckDB: loading" when health is undefined', () => {
    mockWorkerHealth = undefined;
    render(<StatusBar />);
    expect(screen.getByText('DuckDB: loading')).toBeDefined();
  });

  it('shows correct status indicator color for ready (green)', () => {
    render(<StatusBar />);
    // The status indicator is the span with 8px width/height circle
    const statusText = screen.getByText('DuckDB: ready');
    const statusContainer = statusText.parentElement!;
    const indicator = statusContainer.querySelector('span')!;
    expect(indicator.style.backgroundColor).toBe('rgb(34, 197, 94)');
  });

  it('shows correct status indicator color for busy (yellow)', () => {
    mockWorkerHealth = { ...mockWorkerHealth!, status: 'busy' };
    render(<StatusBar />);
    const statusText = screen.getByText('DuckDB: busy');
    const statusContainer = statusText.parentElement!;
    const indicator = statusContainer.querySelector('span')!;
    expect(indicator.style.backgroundColor).toBe('rgb(234, 179, 8)');
  });

  it('shows correct status indicator color for failed (red)', () => {
    mockWorkerHealth = { ...mockWorkerHealth!, status: 'failed' };
    render(<StatusBar />);
    const statusText = screen.getByText('DuckDB: failed');
    const statusContainer = statusText.parentElement!;
    const indicator = statusContainer.querySelector('span')!;
    expect(indicator.style.backgroundColor).toBe('rgb(239, 68, 68)');
  });

  it('shows active query count when > 0', () => {
    mockRunningQueries = [
      { id: 'q-1', status: 'running' },
      { id: 'q-2', status: 'running' },
    ];
    render(<StatusBar />);
    expect(screen.getByText('(2 active)')).toBeDefined();
  });

  it('does not show active count when 0', () => {
    mockRunningQueries = [];
    render(<StatusBar />);
    expect(screen.queryByText(/active/)).toBeNull();
  });

  it('shows degraded warning banner', () => {
    mockWorkerHealth = { ...mockWorkerHealth!, status: 'degraded' };
    render(<StatusBar />);
    expect(
      screen.getByText('DuckDB engine is experiencing issues. Automatic recovery in progress.'),
    ).toBeDefined();
  });

  it('shows failed warning banner', () => {
    mockWorkerHealth = { ...mockWorkerHealth!, status: 'failed' };
    render(<StatusBar />);
    expect(
      screen.getByText(
        'DuckDB engine has failed and cannot restart. Please restart the application.',
      ),
    ).toBeDefined();
  });

  it('shows restarting warning banner with restart count', () => {
    mockWorkerHealth = {
      ...mockWorkerHealth!,
      status: 'restarting',
      restartCount: 2,
    };
    render(<StatusBar />);
    expect(screen.getByText('DuckDB engine is restarting (attempt 2).')).toBeDefined();
  });

  it('shows recovery banner when recoveryTriggered is true', () => {
    mockRecoveryTriggered = true;
    render(<StatusBar />);
    expect(
      screen.getByText(
        'Previous session did not shut down cleanly. Recovery completed successfully.',
      ),
    ).toBeDefined();
  });

  it('does not show recovery banner when recoveryTriggered is undefined', () => {
    mockRecoveryTriggered = undefined;
    render(<StatusBar />);
    expect(screen.queryByText(/Previous session did not shut down cleanly/)).toBeNull();
  });
});
