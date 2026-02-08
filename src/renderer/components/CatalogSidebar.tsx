import type { DataGridTab, DataSource } from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';
import { useCallback } from 'react';
import { db } from '../stores/db';
import { useCatalogSources, useTabs } from '../stores/hooks';
import { ImportDialog } from './ImportDialog';

/**
 * Color-coded status dot colors for data source lifecycle states.
 * Green = active, yellow = importing/stale, red = error, gray = removed.
 */
const STATUS_COLORS: Record<DataSource['status'], string> = {
  active: '#10b981',
  importing: '#f59e0b',
  stale: '#f59e0b',
  error: '#ef4444',
  removed: '#6b7280',
};

/**
 * Abbreviated format labels for display in small badges.
 */
const FORMAT_LABELS: Record<DataSource['format'], string> = {
  csv: 'CSV',
  tsv: 'TSV',
  parquet: 'PQT',
  json: 'JSON',
  jsonl: 'JSONL',
  xlsx: 'XLSX',
  arrow_ipc: 'ARROW',
};

/**
 * Sidebar component displaying imported data sources with status indicators.
 * Each source shows its name, a color-coded status dot, format badge,
 * and formatted row count. Includes an import button for triggering file
 * ingestion and an empty state message when no sources have been imported.
 *
 * Clicking an active source opens (or focuses) a `data_grid` tab for that source.
 */
export function CatalogSidebar(): ReactElement {
  const sources = useCatalogSources();
  const tabs = useTabs();

  const handleSourceClick = useCallback(
    (source: DataSource): void => {
      if (source.status !== 'active' || !source.duckdbTableName) return;

      const tableName = source.duckdbTableName;

      void (async () => {
        // Check if a data_grid tab already exists for this source
        const existingTab = tabs?.find(
          (t): t is DataGridTab => t.type === 'data_grid' && t.state.dataSourceId === source.id,
        );

        if (existingTab) {
          // Focus the existing tab
          await db.transaction('rw', db.tabs, async () => {
            await db.tabs.toCollection().modify({ active: false });
            await db.tabs.update(existingTab.id, { active: true });
          });
          return;
        }

        // Create a new data_grid tab
        const currentTabs = await db.tabs.toArray();
        const maxOrder = currentTabs.reduce((max, t) => Math.max(max, t.order), -1);

        await db.transaction('rw', db.tabs, async () => {
          await db.tabs.toCollection().modify({ active: false });
          await db.tabs.add({
            id: crypto.randomUUID(),
            type: 'data_grid',
            order: maxOrder + 1,
            title: source.name,
            active: true,
            state: {
              dataSourceId: source.id,
              tableName,
            },
            lastAccessedAt: new Date().toISOString(),
          });
        });
      })();
    },
    [tabs],
  );

  return (
    <aside style={styles.sidebar} aria-label="Data Sources">
      <div style={styles.header}>
        <h2 style={styles.title}>Data Sources</h2>
        <ImportDialog />
      </div>
      <div style={styles.list}>
        {!sources || sources.length === 0 ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>No data sources yet.</p>
            <p style={styles.emptyHint}>
              <button
                type="button"
                style={styles.emptyAction}
                onClick={() => {
                  void window.datspace.ingestion.importFiles([], 'file_picker');
                }}
              >
                Import files
              </button>{' '}
              or drag & drop to get started.
            </p>
          </div>
        ) : (
          sources.map((source) => (
            <button
              key={source.id}
              type="button"
              style={styles.sourceItem}
              onClick={() => {
                handleSourceClick(source);
              }}
              title={source.filePath}
            >
              <span
                role="img"
                style={{
                  ...styles.statusDot,
                  backgroundColor: STATUS_COLORS[source.status],
                }}
                aria-label={`Status: ${source.status}`}
              />
              <div style={styles.sourceInfo}>
                <span style={styles.sourceName}>{source.name}</span>
                <span style={styles.sourceMeta}>
                  {source.status === 'error'
                    ? 'Import failed'
                    : source.status === 'stale'
                      ? 'Re-import needed'
                      : source.status === 'importing'
                        ? 'Importing...'
                        : source.rowCount != null
                          ? `${source.rowCount.toLocaleString()} rows`
                          : '—'}
                </span>
              </div>
              <span style={styles.formatBadge}>{FORMAT_LABELS[source.format]}</span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

const styles = {
  sidebar: {
    width: 240,
    minWidth: 240,
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: '#111827',
    color: '#f9fafb',
    borderRight: '1px solid #1f2937',
    overflow: 'hidden' as const,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 12px 8px',
    borderBottom: '1px solid #1f2937',
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    margin: 0,
    color: '#e5e7eb',
    letterSpacing: '0.01em',
  },
  list: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '4px 0',
  },
  empty: {
    padding: '24px 16px',
    textAlign: 'center' as const,
  },
  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
    margin: '0 0 8px',
  },
  emptyHint: {
    fontSize: 12,
    color: '#6b7280',
    margin: 0,
  },
  emptyAction: {
    fontSize: 12,
    color: '#3b82f6',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    textDecoration: 'underline',
    fontFamily: 'inherit',
  },
  sourceItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '8px 12px',
    border: 'none',
    borderRadius: 0,
    backgroundColor: 'transparent',
    color: '#f9fafb',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontSize: 13,
  },
  statusDot: {
    width: 8,
    height: 8,
    minWidth: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  sourceInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 0,
    gap: 2,
  },
  sourceName: {
    fontWeight: 600,
    fontSize: 13,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  sourceMeta: {
    fontSize: 11,
    color: '#9ca3af',
  },
  formatBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 4,
    backgroundColor: '#374151',
    color: '#d1d5db',
    letterSpacing: '0.03em',
    flexShrink: 0,
    lineHeight: '14px',
  },
} satisfies Record<string, React.CSSProperties>;
