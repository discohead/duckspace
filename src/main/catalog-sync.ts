import type { BrowserWindow } from 'electron';
import type { Worker } from 'worker_threads';
import type { CatalogEntry, ColumnSchema } from '@shared/types';
import { PUSH_EVENTS } from '@shared/constants';

/**
 * CatalogSyncBridge: pushes catalog updates from Worker to Renderer via Dexie.js.
 * Main Process listens for catalog-related Worker messages and forwards to Renderer.
 */
export class CatalogSyncBridge {
  private mainWindow: BrowserWindow | null = null;
  private worker: Worker | null = null;

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setWorker(worker: Worker): void {
    this.worker = worker;
    this.setupWorkerListener();
  }

  private setupWorkerListener(): void {
    if (!this.worker) return;

    this.worker.on('message', (msg: Record<string, unknown>) => {
      if (msg.type === 'catalog_update') {
        this.pushCatalogUpdate(msg);
      }
    });
  }

  private pushCatalogUpdate(msg: Record<string, unknown>): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    const entry: CatalogEntry = {
      id: `catalog-${msg.table as string}`,
      name: msg.table as string,
      schema: 'main',
      type: (msg.registrationType as 'table' | 'view') ?? 'table',
      status: 'active',
      rowCount: (msg.rowCount as number) ?? 0,
      sizeBytes: (msg.sizeBytes as number) ?? 0,
      columnCount: ((msg.columns as ColumnSchema[]) ?? []).length,
      registeredAt: new Date().toISOString(),
    };

    this.mainWindow.webContents.send('catalog:update', {
      entry,
      columns: (msg.columns as ColumnSchema[]) ?? [],
    });
  }

  /** Trigger a full catalog refresh by querying the Worker */
  async refreshCatalog(): Promise<void> {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'list_tables' });
  }
}
