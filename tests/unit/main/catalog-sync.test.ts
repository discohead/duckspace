import { CatalogSyncBridge } from '@main/catalog-sync';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockWorker() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
    }),
    postMessage: vi.fn(),
    _emit(event: string, ...args: any[]) {
      listeners.get(event)?.forEach((h) => {
        h(...args);
      });
    },
  };
}

function createMockBrowserWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
}

describe('CatalogSyncBridge', () => {
  let bridge: CatalogSyncBridge;
  let worker: ReturnType<typeof createMockWorker>;
  let mainWindow: ReturnType<typeof createMockBrowserWindow>;

  beforeEach(() => {
    bridge = new CatalogSyncBridge();
    worker = createMockWorker();
    mainWindow = createMockBrowserWindow();
  });

  describe('setWorker', () => {
    it('listens for catalog_update messages', () => {
      bridge.setWorker(worker as any);
      expect(worker.on).toHaveBeenCalledWith('message', expect.any(Function));
    });
  });

  describe('catalog update forwarding', () => {
    it('forwards catalog_update to renderer', () => {
      bridge.setMainWindow(mainWindow as any);
      bridge.setWorker(worker as any);

      worker._emit('message', {
        type: 'catalog_update',
        table: 'users',
        columns: [
          {
            name: 'id',
            duckdbType: 'INTEGER',
            arrowType: 'Int32',
            nullable: false,
            ordinalPosition: 0,
          },
        ],
        rowCount: 100,
        sizeBytes: 4096,
        registrationType: 'table',
      });

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'catalog:update',
        expect.objectContaining({
          entry: expect.objectContaining({
            name: 'users',
            type: 'table',
            status: 'active',
            rowCount: 100,
            sizeBytes: 4096,
            columnCount: 1,
          }),
          columns: expect.arrayContaining([expect.objectContaining({ name: 'id' })]),
        }),
      );
    });

    it('ignores non-catalog messages', () => {
      bridge.setMainWindow(mainWindow as any);
      bridge.setWorker(worker as any);

      worker._emit('message', { type: 'ready', worker: 'duckdb' });

      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('does nothing when window is destroyed', () => {
      mainWindow.isDestroyed.mockReturnValue(true);
      bridge.setMainWindow(mainWindow as any);
      bridge.setWorker(worker as any);

      worker._emit('message', {
        type: 'catalog_update',
        table: 'users',
        columns: [],
        rowCount: 0,
        sizeBytes: 0,
      });

      expect(mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    it('does nothing when no main window set', () => {
      bridge.setWorker(worker as any);

      // Should not throw
      worker._emit('message', {
        type: 'catalog_update',
        table: 'users',
        columns: [],
        rowCount: 0,
        sizeBytes: 0,
      });
    });

    it('defaults registrationType to table', () => {
      bridge.setMainWindow(mainWindow as any);
      bridge.setWorker(worker as any);

      worker._emit('message', {
        type: 'catalog_update',
        table: 'my_view',
        columns: [],
        rowCount: 0,
        sizeBytes: 0,
        // no registrationType
      });

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'catalog:update',
        expect.objectContaining({
          entry: expect.objectContaining({
            type: 'table',
          }),
        }),
      );
    });

    it('handles view registrationType', () => {
      bridge.setMainWindow(mainWindow as any);
      bridge.setWorker(worker as any);

      worker._emit('message', {
        type: 'catalog_update',
        table: 'user_summary',
        columns: [],
        rowCount: 50,
        sizeBytes: 0,
        registrationType: 'view',
      });

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'catalog:update',
        expect.objectContaining({
          entry: expect.objectContaining({
            name: 'user_summary',
            type: 'view',
          }),
        }),
      );
    });
  });

  describe('refreshCatalog', () => {
    it('sends list_tables message to worker', () => {
      bridge.setWorker(worker as any);

      bridge.refreshCatalog();

      expect(worker.postMessage).toHaveBeenCalledWith({ type: 'list_tables' });
    });

    it('does nothing when no worker set', () => {
      // Should not throw
      bridge.refreshCatalog();
    });
  });
});
