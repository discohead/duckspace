/**
 * Perspective.js bridge for managing WASM Worker and per-tab Table instances.
 *
 * Creates a single Perspective Web Worker on first use, then manages
 * per-tab Perspective Tables that consume Arrow IPC ArrayBuffers directly.
 * Tables are keyed by tab ID and cleaned up when tabs close.
 *
 * @module perspective-bridge
 */

import type perspective from '@finos/perspective';

type PerspectiveClient = Awaited<ReturnType<typeof perspective.worker>>;
type PerspectiveTable = Awaited<ReturnType<PerspectiveClient['table']>>;

/** Lazy singleton for the Perspective WASM Web Worker client. */
let clientPromise: Promise<PerspectiveClient> | undefined;

/** Per-tab Perspective Table instances, keyed by tab ID. */
const tables = new Map<string, PerspectiveTable>();

/**
 * Get or create the singleton Perspective Web Worker client.
 * The WASM binary is loaded lazily on first call (~7.3 MB).
 * Explicitly initializes client + server WASM before creating the worker,
 * since the Vite dev server doesn't auto-resolve WASM imports from node_modules.
 *
 * @returns The Perspective client connected to a Web Worker.
 */
export async function getClient(): Promise<PerspectiveClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      // Dynamic import to keep initial bundle small — WASM loads lazily
      const psp = await import('@finos/perspective');
      const pspViewer = await import('@finos/perspective-viewer');

      // The ESM builds don't auto-load WASM binaries. We must explicitly
      // initialize both the viewer and server WASM before creating a worker.
      //
      // Critical ordering: perspective's internal get_client() checks for the
      // "perspective-viewer" custom element FIRST — if registered, it uses
      // __wasm_module__ from the element class (ignoring init_client). Since
      // DataGrid.tsx imports @finos/perspective-viewer (registering the element),
      // we MUST await the viewer's init_client so __wasm_module__ is populated.
      const viewerWasm = fetch(
        new URL(
          '/node_modules/@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm',
          window.location.origin,
        ),
      );
      const serverWasm = fetch(
        new URL(
          '/node_modules/@finos/perspective/dist/wasm/perspective-server.wasm',
          window.location.origin,
        ),
      );

      // Await viewer init — sets __wasm_module__ on the custom element class
      await pspViewer.default.init_client(viewerWasm);
      // Server WASM can load in parallel (init_server is fire-and-forget)
      psp.default.init_server(serverWasm);

      return psp.default.worker();
    })();
  }
  return clientPromise;
}

/**
 * Create a new Perspective Table from the first Arrow IPC batch for a tab.
 * If a table already exists for this tab, it is deleted first.
 *
 * @param tabId - The tab ID to associate this table with.
 * @param arrowBuffer - The first Arrow IPC ArrayBuffer (contains schema + data).
 * @returns The created Perspective Table.
 */
export async function createTable(
  tabId: string,
  arrowBuffer: ArrayBuffer,
): Promise<PerspectiveTable> {
  // Clean up any existing table for this tab
  const existing = tables.get(tabId);
  if (existing) {
    try {
      await existing.delete();
    } catch {
      // Table may already be deleted — ignore
    }
    tables.delete(tabId);
  }

  const client = await getClient();
  const table = await client.table(arrowBuffer);
  tables.set(tabId, table);
  return table;
}

/**
 * Append data to an existing Perspective Table for a tab.
 * If no table exists for this tab, the update is silently dropped.
 *
 * @param tabId - The tab ID whose table should be updated.
 * @param arrowBuffer - An Arrow IPC ArrayBuffer with additional data batches.
 */
export async function updateTable(tabId: string, arrowBuffer: ArrayBuffer): Promise<void> {
  const table = tables.get(tabId);
  if (!table) return;
  await table.update(arrowBuffer);
}

/**
 * Get the Perspective Table for a tab, if one exists.
 *
 * @param tabId - The tab ID to look up.
 * @returns The Perspective Table, or undefined if no table exists for this tab.
 */
export function getTable(tabId: string): PerspectiveTable | undefined {
  return tables.get(tabId);
}

/**
 * Delete the Perspective Table for a tab and remove it from the registry.
 * Safe to call even if no table exists for the tab.
 *
 * @param tabId - The tab ID whose table should be deleted.
 */
export async function deleteTable(tabId: string): Promise<void> {
  const table = tables.get(tabId);
  if (!table) return;
  tables.delete(tabId);
  try {
    await table.delete();
  } catch {
    // Table may already be deleted — ignore
  }
}

/**
 * Check whether a Perspective Table exists for a tab.
 *
 * @param tabId - The tab ID to check.
 * @returns True if a table exists for this tab.
 */
export function hasTable(tabId: string): boolean {
  return tables.has(tabId);
}
