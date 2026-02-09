/**
 * Data grid component wrapping Perspective.js for high-performance data viewing.
 *
 * Accepts a tab ID, subscribes to Arrow IPC batches via the preload data-plane API,
 * creates a Perspective Table from the first batch, appends subsequent batches,
 * and renders via `<PerspectiveViewer>` with the `datagrid` plugin.
 *
 * Handles table lifecycle: creates on mount/data arrival, deletes on unmount.
 *
 * @module DataGrid
 */

import '@finos/perspective-viewer';
import '@finos/perspective-viewer-datagrid';

import type { Table } from '@finos/perspective';
import { PerspectiveViewer } from '@finos/perspective-react';
import type { ArrowBatch, DataGridTabState } from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createTable, deleteTable, getTable, updateTable } from '../lib/perspective-bridge';

/**
 * Process an Arrow IPC batch — create a new Perspective Table on the first
 * batch or append data on subsequent batches.
 *
 * @returns The current Perspective Table and its row count.
 */
async function processBatch(
  tabId: string,
  buffer: ArrayBuffer,
): Promise<{ table: Table; rowCount: number }> {
  const existing = getTable(tabId);
  if (!existing) {
    const newTable = await createTable(tabId, buffer);
    const size = await newTable.size();
    return { table: newTable, rowCount: size };
  }
  await updateTable(tabId, buffer);
  const size = await existing.size();
  return { table: existing, rowCount: size };
}

/** Props for the {@link DataGrid} component. */
interface DataGridProps {
  /** The tab ID (used for Perspective table keying). */
  tabId: string;
  /** The data grid tab state containing dataSourceId and tableName. */
  tabState: DataGridTabState;
}

/**
 * Interactive data grid powered by Perspective.js WASM engine.
 * Consumes Arrow IPC buffers directly from the data plane,
 * creates a Perspective Table, and renders with virtual scrolling.
 *
 * @param props - Component props with tab ID and state.
 */
export function DataGrid({ tabId, tabState }: DataGridProps): ReactElement {
  const [table, setTable] = useState<Table | Promise<Table> | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowCount, setRowCount] = useState<number>(0);
  /** Prevent double-initiation on StrictMode remount. */
  const queryInitiatedRef = useRef(false);
  /** Track the active query ID so we can cancel on unmount. */
  const activeQueryIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!tabState.tableName || queryInitiatedRef.current) return;
    queryInitiatedRef.current = true;

    let unsubData: (() => void) | undefined;
    let cancelled = false;

    const loadData = async (): Promise<void> => {
      try {
        setIsLoading(true);
        setError(null);

        // Execute SELECT * via existing previewTable which streams Arrow IPC
        const handle = await window.datspace.catalog.previewTable(tabState.tableName);

        if (cancelled) return;

        activeQueryIdRef.current = handle.queryId;

        // Subscribe to Arrow IPC data batches for this query
        unsubData = window.datspace.query.onData(handle.queryId, (batch: ArrowBatch) => {
          if (cancelled) return;

          // Handle data-plane errors
          if (batch.error) {
            setError(`[${batch.error.code}] ${batch.error.message}`);
            setIsLoading(false);
            return;
          }

          // Stream end — done loading
          if (batch.isLast) {
            activeQueryIdRef.current = null;
            setIsLoading(false);
            return;
          }

          // Skip empty buffers
          if (batch.buffer.byteLength === 0) return;

          // Create or update Perspective table
          void processBatch(tabId, batch.buffer).then(
            (result) => {
              if (!cancelled) {
                setTable(result.table);
                setRowCount(result.rowCount);
              }
            },
            (err: unknown) => {
              if (!cancelled) {
                const msg = err instanceof Error ? err.message : 'Failed to process data batch';
                console.error('DataGrid batch error:', msg);
                setError(msg);
              }
            },
          );
        });
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load data';
          setError(msg);
          setIsLoading(false);
        }
      }
    };

    void loadData();

    return () => {
      cancelled = true;
      queryInitiatedRef.current = false;
      unsubData?.();

      // Cancel the active query to prevent concurrent to_arrow_ipc() calls
      // which can trigger nanoarrow SIGTRAP crashes on tab switch.
      const qid = activeQueryIdRef.current;
      if (qid) {
        activeQueryIdRef.current = null;
        void window.datspace.query.cancel(qid);
      }

      void deleteTable(tabId);
    };
  }, [tabId, tabState.tableName]);

  /** Ref to the wrapper div — used to find the perspective-viewer element
   *  and inject CSS into its shadow DOM to hide the settings button. */
  const viewerWrapperRef = useRef<HTMLDivElement>(null);

  // Hide the settings/configure button inside perspective-viewer's shadow DOM.
  // The button has id="settings_button" and no ::part attribute, so it can
  // only be hidden via a style injected into the shadow root.
  // biome-ignore lint/correctness/useExhaustiveDependencies: table gates PerspectiveViewer render; effect must re-run when viewer appears
  useEffect(() => {
    const viewer = viewerWrapperRef.current?.querySelector('perspective-viewer');
    if (!viewer?.shadowRoot) return;

    const style = document.createElement('style');
    style.textContent = '#settings_button { display: none !important; }';
    viewer.shadowRoot.appendChild(style);

    return () => {
      style.remove();
    };
  }, [table]);

  // Loading state
  if (isLoading && !table) {
    return (
      <div style={styles.centered}>
        <span style={styles.loadingText}>Loading {tabState.tableName}...</span>
      </div>
    );
  }

  // Error state
  if (error && !table) {
    return (
      <div style={styles.centered}>
        <div style={styles.errorPanel}>
          <strong>Error loading data</strong>
          <p style={styles.errorMessage}>{error}</p>
        </div>
      </div>
    );
  }

  if (!table) {
    return (
      <div style={styles.centered}>
        <span style={styles.loadingText}>Initializing grid...</span>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div ref={viewerWrapperRef} style={styles.viewerWrapper}>
        <PerspectiveViewer
          table={table}
          config={{
            plugin: 'Datagrid',
            settings: false,
          }}
          style={styles.viewer}
        />
      </div>
      <div style={styles.footer}>
        <span style={styles.footerText}>
          {rowCount.toLocaleString()} row{rowCount !== 1 ? 's' : ''}
          {isLoading ? ' (loading...)' : ''}
        </span>
        <span style={styles.footerSource}>{tabState.tableName}</span>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    width: '100%',
    overflow: 'hidden' as const,
  },
  viewerWrapper: {
    flex: 1,
    width: '100%',
    overflow: 'hidden' as const,
    position: 'relative' as const,
  },
  viewer: {
    width: '100%',
    height: '100%',
  },
  centered: {
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    height: '100%',
    width: '100%',
  },
  loadingText: {
    fontSize: 14,
    color: '#6b7280',
  },
  errorPanel: {
    padding: 16,
    backgroundColor: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: 8,
    color: '#b91c1c',
    maxWidth: 400,
    textAlign: 'center' as const,
  },
  errorMessage: {
    fontSize: 13,
    marginTop: 8,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    padding: '6px 12px',
    fontSize: 12,
    color: '#6b7280',
    backgroundColor: '#f9fafb',
    borderTop: '1px solid #e5e7eb',
    flexShrink: 0,
  },
  footerText: {
    fontFamily: 'monospace',
  },
  footerSource: {
    fontFamily: 'monospace',
    color: '#9ca3af',
  },
} satisfies Record<string, React.CSSProperties>;
