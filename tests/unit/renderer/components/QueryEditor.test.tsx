// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

const mockActiveTab = {
  id: 'tab-1',
  type: 'query' as const,
  order: 0,
  title: 'Query 1',
  active: true,
  state: { sql: 'SELECT 1' },
  lastAccessedAt: '',
};

let currentMockTab: typeof mockActiveTab | undefined = mockActiveTab;

vi.mock('@renderer/stores/hooks', () => ({
  useActiveTab: vi.fn(() => currentMockTab),
}));

vi.mock('@renderer/stores/db', () => ({
  default: {
    tabs: { update: vi.fn().mockResolvedValue(1) },
    queries: {
      add: vi.fn().mockResolvedValue('q-1'),
      update: vi.fn().mockResolvedValue(1),
    },
  },
}));

import QueryEditor from '@renderer/components/QueryEditor';

describe('QueryEditor', () => {
  beforeEach(() => {
    currentMockTab = mockActiveTab;

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

  it('renders textarea with SQL from active tab', () => {
    render(<QueryEditor />);
    const textarea = screen.getByPlaceholderText('Enter SQL query...');
    expect(textarea).toBeDefined();
    expect((textarea as HTMLTextAreaElement).value).toBe('SELECT 1');
  });

  it('renders Execute button', () => {
    render(<QueryEditor />);
    expect(screen.getByText('Execute')).toBeDefined();
  });

  it('Execute button is not disabled when SQL is present', () => {
    render(<QueryEditor />);
    const button = screen.getByText('Execute');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('Execute button is disabled when active tab has empty SQL', () => {
    currentMockTab = {
      ...mockActiveTab,
      state: { sql: '' },
    };
    render(<QueryEditor />);
    const button = screen.getByText('Execute');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not render Cancel button in initial (non-executing) state', () => {
    render(<QueryEditor />);
    expect(screen.queryByText('Cancel')).toBeNull();
  });

  it('does not render error panel in initial state', () => {
    render(<QueryEditor />);
    // Error panel would contain a <strong> element with error code
    expect(screen.queryByRole('strong')).toBeNull();
  });

  it('subscribes to query status updates on mount', () => {
    render(<QueryEditor />);
    expect(window.datspace.query.onStatus).toHaveBeenCalled();
  });

  it('clicking Execute calls window.datspace.query.execute', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    render(<QueryEditor />);
    fireEvent.click(screen.getByText('Execute'));
    await waitFor(() => {
      expect(window.datspace.query.execute).toHaveBeenCalledWith('SELECT 1');
    });
  });

  it('shows Cancel button after executing', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    render(<QueryEditor />);
    fireEvent.click(screen.getByText('Execute'));
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeDefined();
    });
  });

  it('shows error panel when execute fails', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    (window.datspace.query.execute as ReturnType<typeof vi.fn>).mockRejectedValue({
      code: 'E1001',
      message: 'Syntax error in SQL',
    });
    render(<QueryEditor />);
    fireEvent.click(screen.getByText('Execute'));
    await waitFor(() => {
      expect(screen.getByText('[E1001]')).toBeDefined();
      expect(screen.getByText('Syntax error in SQL')).toBeDefined();
    });
  });

  it('updates textarea value on change', async () => {
    const { fireEvent } = await import('@testing-library/react');
    render(<QueryEditor />);
    const textarea = screen.getByPlaceholderText('Enter SQL query...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'SELECT * FROM products' } });
    expect(textarea.value).toBe('SELECT * FROM products');
  });

  it('clicking Cancel calls window.datspace.query.cancel', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    render(<QueryEditor />);
    fireEvent.click(screen.getByText('Execute'));
    await waitFor(() => {
      expect(screen.getByText('Cancel')).toBeDefined();
    });
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(window.datspace.query.cancel).toHaveBeenCalledWith('q-123');
    });
  });

  it('shows status display during execution', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    // Capture the onStatus callback so we can trigger it
    let statusCallback: ((status: any) => void) | null = null;
    (window.datspace.query.onStatus as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (status: any) => void) => {
        statusCallback = cb;
        return () => {};
      },
    );

    render(<QueryEditor />);
    fireEvent.click(screen.getByText('Execute'));

    await waitFor(() => {
      expect(statusCallback).not.toBeNull();
    });

    // Trigger a status update matching the current queryId
    statusCallback!({
      queryId: 'q-123',
      phase: 'scanning',
      elapsedMs: 150,
      batchesStreamed: 2,
    });

    await waitFor(() => {
      expect(screen.getByText(/scanning/)).toBeDefined();
      expect(screen.getByText(/150ms/)).toBeDefined();
    });
  });
});
