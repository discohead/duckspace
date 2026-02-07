// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const mockEntries = [
  {
    id: 'cat-1',
    name: 'products',
    schema: 'main',
    type: 'table' as const,
    status: 'active' as const,
    rowCount: 500,
    sizeBytes: 0,
    columnCount: 5,
    registeredAt: '',
  },
  {
    id: 'cat-2',
    name: 'sales',
    schema: 'main',
    type: 'view' as const,
    status: 'active' as const,
    rowCount: 1000,
    sizeBytes: 0,
    columnCount: 7,
    registeredAt: '',
  },
];

let currentEntries: typeof mockEntries | undefined = mockEntries;

vi.mock('@renderer/stores/hooks', () => ({
  useCatalogEntries: vi.fn(() => currentEntries),
  useColumnSchemas: vi.fn(() => [
    {
      id: 'col-1',
      catalogEntryId: 'cat-1',
      columnName: 'id',
      columnType: 'INTEGER',
      arrowType: 'Int32',
      nullable: false,
      ordinalPosition: 0,
    },
  ]),
}));

import CatalogBrowser from '@renderer/components/CatalogBrowser';

describe('CatalogBrowser', () => {
  beforeEach(() => {
    currentEntries = mockEntries;

    window.datspace = {
      catalog: {
        previewTable: vi.fn(),
        listTables: vi.fn(),
        describeTable: vi.fn(),
      },
      query: {
        execute: vi.fn(),
        cancel: vi.fn(),
        onStatus: vi.fn(),
        onData: vi.fn(),
        onQueryHistory: vi.fn(),
      },
      lifecycle: {
        ready: vi.fn(),
        getAppState: vi.fn(),
        shutdownAck: vi.fn(),
        onWorkerHealth: vi.fn(),
        onShutdownPrepare: vi.fn(),
        onBoundsChanged: vi.fn(),
      },
    } as any;
  });

  it('renders empty state when entries is an empty array', () => {
    currentEntries = [];
    render(<CatalogBrowser />);
    expect(
      screen.getByText(
        'No tables registered. Execute CREATE TABLE or import data.',
      ),
    ).toBeDefined();
  });

  it('renders table names', () => {
    render(<CatalogBrowser />);
    expect(screen.getByText('products')).toBeDefined();
    expect(screen.getByText('sales')).toBeDefined();
  });

  it('renders type badges (table/view)', () => {
    render(<CatalogBrowser />);
    expect(screen.getByText('table')).toBeDefined();
    expect(screen.getByText('view')).toBeDefined();
  });

  it('renders row count and column count', () => {
    render(<CatalogBrowser />);
    // "500 rows · 5 columns" is rendered with &middot; entity
    expect(screen.getByText(/500 rows/)).toBeDefined();
    expect(screen.getByText(/5 columns/)).toBeDefined();
    expect(screen.getByText(/1,000 rows/)).toBeDefined();
    expect(screen.getByText(/7 columns/)).toBeDefined();
  });

  it('shows "Tables" header', () => {
    render(<CatalogBrowser />);
    expect(screen.getByText('Tables')).toBeDefined();
  });

  it('shows "Select a table to view its schema" when no selection', () => {
    render(<CatalogBrowser />);
    expect(
      screen.getByText('Select a table to view its schema'),
    ).toBeDefined();
  });

  it('clicking a table entry shows its column schema', () => {
    render(<CatalogBrowser />);
    // Click on the products entry
    fireEvent.click(screen.getByText('products'));
    // The ColumnSchemaTable should now render with column details
    expect(screen.getByText('id')).toBeDefined();
    expect(screen.getByText('INTEGER')).toBeDefined();
    expect(screen.getByText('Int32')).toBeDefined();
    // Preview button should appear
    expect(screen.getByText('Preview')).toBeDefined();
  });

  it('does not render when entries is undefined (loading)', () => {
    currentEntries = undefined;
    render(<CatalogBrowser />);
    // Should not show empty state or table list
    expect(
      screen.queryByText('No tables registered. Execute CREATE TABLE or import data.'),
    ).toBeNull();
    expect(screen.queryByText('products')).toBeNull();
  });
});
