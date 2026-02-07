// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTabs = [
  {
    id: 'tab-1',
    type: 'query' as const,
    order: 0,
    title: 'Query 1',
    active: true,
    state: { sql: '' },
    lastAccessedAt: '2024-01-01',
  },
  {
    id: 'tab-2',
    type: 'catalog' as const,
    order: 1,
    title: 'Catalog',
    active: false,
    state: {},
    lastAccessedAt: '2024-01-01',
  },
];

vi.mock('@renderer/stores/hooks', () => ({
  useTabs: vi.fn(() => mockTabs),
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
      transaction: vi.fn((_mode: string, _table: unknown, fn: () => unknown) => fn()),
    },
  };
});

// Mock crypto.randomUUID for createTab
beforeEach(() => {
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn().mockReturnValue('mock-uuid'),
  });
});

import { TabBar } from '@renderer/components/TabBar';
import { db } from '@renderer/stores/db';

describe('TabBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mocks that were cleared
    (db.tabs.toCollection as ReturnType<typeof vi.fn>).mockReturnValue({
      modify: vi.fn().mockResolvedValue(0),
    });
    (db.tabs.update as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (db.tabs.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (db.tabs.add as ReturnType<typeof vi.fn>).mockResolvedValue('new-id');
    (db.tabs.toArray as ReturnType<typeof vi.fn>).mockResolvedValue(mockTabs);
    (db.transaction as ReturnType<typeof vi.fn>).mockImplementation(
      (_mode: string, _table: unknown, fn: () => unknown) => fn(),
    );
  });

  it('renders tab titles', () => {
    render(<TabBar />);
    expect(screen.getByText('Query 1')).toBeDefined();
    expect(screen.getByText('Catalog')).toBeDefined();
  });

  it('renders type icons (Q for query, C for catalog)', () => {
    render(<TabBar />);
    expect(screen.getByText('Q')).toBeDefined();
    expect(screen.getByText('C')).toBeDefined();
  });

  it('active tab has fontWeight 600', () => {
    render(<TabBar />);
    const activeButton = screen.getByText('Query 1').closest('button');
    expect(activeButton).toBeDefined();
    expect(activeButton?.style.fontWeight).toBe('600');
  });

  it('inactive tab has normal fontWeight', () => {
    render(<TabBar />);
    const inactiveButton = screen.getByText('Catalog').closest('button');
    expect(inactiveButton).toBeDefined();
    expect(inactiveButton?.style.fontWeight).toBe('normal');
  });

  it('renders "+" button for creating new tabs', () => {
    render(<TabBar />);
    expect(screen.getByText('+')).toBeDefined();
  });

  it('clicking a tab calls db.transaction to activate it', async () => {
    render(<TabBar />);
    // The "Catalog" text is in a <span> inside the outer tab <button>
    const catalogButton = screen.getByText('Catalog').closest('button');
    fireEvent.click(catalogButton!);
    // activateTab is async and calls db.transaction
    await waitFor(() => {
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  it('renders close button (x) for each tab', () => {
    render(<TabBar />);
    const closeButtons = screen.getAllByText('x');
    expect(closeButtons).toHaveLength(2);
  });

  it('clicking close button calls db.tabs.delete', () => {
    render(<TabBar />);
    const closeButtons = screen.getAllByText('x');
    fireEvent.click(closeButtons[0]!);
    expect(db.tabs.delete).toHaveBeenCalledWith('tab-1');
  });
});
