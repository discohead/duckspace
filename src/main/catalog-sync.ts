import type { Worker } from 'node:worker_threads';
import type { CatalogEntry, WorkerCatalogUpdate } from '@shared/types';
import type { BrowserWindow } from 'electron';

/**
 * CatalogSyncBridge: pushes catalog updates from Worker to Renderer via Dexie.js.
 * Main Process listens for catalog-related Worker messages and forwards to Renderer.
 */
export class CatalogSyncBridge {
  private mainWindow: BrowserWindow | null = null;
  private worker: Worker | null = null;

  /**
   * Sets the main window reference for forwarding catalog updates to the renderer.
   *
   * @param win - The main BrowserWindow instance.
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * Attaches a worker thread and begins listening for catalog_update messages.
   *
   * @param worker - The DuckDB worker thread to listen to.
   */
  setWorker(worker: Worker): void {
    this.worker = worker;
    this.setupWorkerListener();
  }

  private setupWorkerListener(): void {
    if (!this.worker) return;

    this.worker.on('message', (msg: Record<string, unknown>) => {
      if (msg['type'] === 'catalog_update') {
        this.pushCatalogUpdate(msg as unknown as WorkerCatalogUpdate);
      }
    });
  }

  private pushCatalogUpdate(msg: WorkerCatalogUpdate): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    /* eslint-disable @typescript-eslint/no-unnecessary-condition -- defensive: worker messages may omit optional fields at runtime */
    const entry: CatalogEntry = {
      id: `catalog-${msg.table}`,
      name: msg.table,
      schema: 'main',
      type: msg.registrationType ?? 'table',
      status: 'active',
      rowCount: msg.rowCount ?? 0,
      sizeBytes: msg.sizeBytes ?? 0,
      columnCount: (msg.columns ?? []).length,
      registeredAt: new Date().toISOString(),
    };
    /* eslint-enable @typescript-eslint/no-unnecessary-condition */

    this.mainWindow.webContents.send('catalog:update', {
      entry,
      columns: msg.columns,
    });
  }

  /** Trigger a full catalog refresh by querying the Worker */
  refreshCatalog(): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'list_tables' });
  }
}
