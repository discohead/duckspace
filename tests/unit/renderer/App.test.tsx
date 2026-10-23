// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/stores/hooks', () => ({
  useTabs: vi.fn(() => undefined),
  useActiveTab: vi.fn(() => undefined),
  useWorkerHealth: vi.fn(() => undefined),
  useRunningQueries: vi.fn(() => undefined),
  useAppState: vi.fn(() => undefined),
  usePreference: vi.fn(() => undefined),
  useCatalogEntries: vi.fn(() => undefined),
  useColumnSchemas: vi.fn(() => undefined),
  useCatalogSources: vi.fn(() => undefined),
  useIngestionJobs: vi.fn(() => undefined),
}));

vi.mock('@renderer/stores/db', () => ({
  db: {
    tabs: {
      toArray: vi.fn().mockResolvedValue([]),
      toCollection: vi.fn().mockReturnValue({ modify: vi.fn() }),
      add: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      filter: vi.fn().mockReturnValue({ first: vi.fn() }),
    },
    transaction: vi.fn((_m: string, _t: unknown, fn: () => unknown) => fn()),
    app_state: { put: vi.fn() },
    data_sources: {
      where: vi.fn().mockReturnValue({
        equals: vi.fn().mockReturnValue({ modify: vi.fn().mockResolvedValue(0) }),
      }),
      filter: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }),
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
      filter: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      update: vi.fn().mockResolvedValue(1),
    },
  },
}));

vi.mock('@renderer/components/TabBar', () => ({
  TabBar: () => <div data-testid="tab-bar">TabBar</div>,
}));
vi.mock('@renderer/components/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar">StatusBar</div>,
}));
vi.mock('@renderer/components/WelcomeView', () => ({
  WelcomeView: () => <div data-testid="welcome-view">WelcomeView</div>,
}));
vi.mock('@renderer/components/QueryEditor', () => ({
  QueryEditor: () => <div data-testid="query-editor">QueryEditor</div>,
}));
vi.mock('@renderer/components/ResultGrid', () => ({
  ResultGrid: () => <div data-testid="result-grid">ResultGrid</div>,
}));
vi.mock('@renderer/components/CatalogBrowser', () => ({
  CatalogBrowser: () => <div data-testid="catalog-browser">CatalogBrowser</div>,
}));
vi.mock('@renderer/components/CatalogSidebar', () => ({
  CatalogSidebar: () => <div data-testid="catalog-sidebar">CatalogSidebar</div>,
}));
vi.mock('@renderer/components/IngestionProgress', () => ({
  IngestionProgress: () => null,
}));

import { App } from '@renderer/App';

const noop = () => () => {};

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock ingestion/catalog/watch push event listeners
    window.duckspace = {
      ...window.duckspace,
      ingestion: {
        ...(window.duckspace?.ingestion ?? {}),
        onProgress: noop,
        onComplete: noop,
      },
      catalog: {
        ...(window.duckspace?.catalog ?? {}),
        onSourceUpdated: noop,
      },
      watch: {
        ...(window.duckspace?.watch ?? {}),
        onFileEvent: noop,
        restoreDirectories: vi.fn().mockResolvedValue(0),
      },
    } as any;
  });

  it('renders TabBar always', () => {
    render(<App />);
    expect(screen.getByTestId('tab-bar')).toBeDefined();
  });

  it('renders StatusBar always', () => {
    render(<App />);
    expect(screen.getByTestId('status-bar')).toBeDefined();
  });

  it('renders WelcomeView when tabs is undefined (no tabs)', () => {
    render(<App />);
    expect(screen.getByTestId('welcome-view')).toBeDefined();
  });

  it('renders WelcomeView when no active tab', async () => {
    const { useTabs } = await import('@renderer/stores/hooks');
    (useTabs as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: 'tab-1',
        type: 'query',
        order: 0,
        title: 'Query 1',
        active: false,
        state: { sql: '' },
        lastAccessedAt: '',
      },
    ]);

    render(<App />);
    // useActiveTab returns undefined, so WelcomeView should appear
    expect(screen.getByTestId('welcome-view')).toBeDefined();
  });

  it('renders WelcomeView when tabs is empty array', async () => {
    const hooks = await import('@renderer/stores/hooks');
    (hooks.useTabs as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (hooks.useActiveTab as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    render(<App />);
    expect(screen.getByTestId('welcome-view')).toBeDefined();
  });

  it('renders QueryEditor and ResultGrid when active tab is query', async () => {
    const hooks = await import('@renderer/stores/hooks');
    const queryTab = {
      id: 'tab-1',
      type: 'query' as const,
      order: 0,
      title: 'Q1',
      active: true,
      state: { sql: 'SELECT 1' },
      lastAccessedAt: '',
    };
    (hooks.useTabs as ReturnType<typeof vi.fn>).mockReturnValue([queryTab]);
    (hooks.useActiveTab as ReturnType<typeof vi.fn>).mockReturnValue(queryTab);

    render(<App />);
    expect(screen.getByTestId('query-editor')).toBeDefined();
    expect(screen.getByTestId('result-grid')).toBeDefined();
  });

  it('renders CatalogBrowser when active tab is catalog', async () => {
    const hooks = await import('@renderer/stores/hooks');
    const catalogTab = {
      id: 'tab-2',
      type: 'catalog' as const,
      order: 0,
      title: 'Cat',
      active: true,
      state: {},
      lastAccessedAt: '',
    };
    (hooks.useTabs as ReturnType<typeof vi.fn>).mockReturnValue([catalogTab]);
    (hooks.useActiveTab as ReturnType<typeof vi.fn>).mockReturnValue(catalogTab);

    render(<App />);
    expect(screen.getByTestId('catalog-browser')).toBeDefined();
  });

  it('renders Settings placeholder when active tab is settings', async () => {
    const hooks = await import('@renderer/stores/hooks');
    const settingsTab = {
      id: 'tab-3',
      type: 'settings' as const,
      order: 0,
      title: 'Settings',
      active: true,
      state: {},
      lastAccessedAt: '',
    };
    (hooks.useTabs as ReturnType<typeof vi.fn>).mockReturnValue([settingsTab]);
    (hooks.useActiveTab as ReturnType<typeof vi.fn>).mockReturnValue(settingsTab);

    render(<App />);
    expect(screen.getByText('Settings')).toBeDefined();
  });

  it('renders TabBar inside a header landmark', () => {
    render(<App />);
    const tabBar = screen.getByTestId('tab-bar');
    expect(tabBar.closest('header')).not.toBeNull();
  });

  it('renders StatusBar inside a footer landmark', () => {
    render(<App />);
    const statusBar = screen.getByTestId('status-bar');
    expect(statusBar.closest('footer')).not.toBeNull();
  });

  it('throws assertNever for unknown tab type', async () => {
    const hooks = await import('@renderer/stores/hooks');
    const unknownTab = {
      id: 'tab-x',
      type: 'unknown' as any,
      order: 0,
      title: 'Unknown',
      active: true,
      state: {},
      lastAccessedAt: '',
    };
    (hooks.useTabs as ReturnType<typeof vi.fn>).mockReturnValue([unknownTab]);
    (hooks.useActiveTab as ReturnType<typeof vi.fn>).mockReturnValue(unknownTab);

    // assertNever throws for unhandled tab types — ErrorBoundary catches it
    expect(() => render(<App />)).toThrow('Unexpected value');
  });
});
