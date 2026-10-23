import type { DataGridTab, DataSource } from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../stores/db';
import { useCatalogSources, useTabs } from '../stores/hooks';
import { ImportDialog } from './ImportDialog';
import { WatchDirConfig } from './WatchDirConfig';

/** Tracks the open context menu position and target data source. */
interface ContextMenuState {
  readonly sourceId: string;
  readonly x: number;
  readonly y: number;
}

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
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Dismiss the context menu on outside click. */
  useEffect(() => {
    if (!contextMenu) return;

    const handleClickOutside = (): void => {
      setContextMenu(null);
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [contextMenu]);

  /** Auto-focus first menu item when context menu opens. */
  useEffect(() => {
    if (contextMenu && menuRef.current) {
      const firstItem = menuRef.current.querySelector<HTMLElement>('[role="menuitem"]');
      firstItem?.focus();
    }
  }, [contextMenu]);

  /** Open context menu on right-click of a source entry. */
  const handleContextMenu = useCallback((e: React.MouseEvent, source: DataSource): void => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ sourceId: source.id, x: e.clientX, y: e.clientY });
  }, []);

  /** Remove a data source from DuckDB and Dexie, with confirmation. */
  const handleRemoveSource = useCallback((sourceId: string, sourceName: string): void => {
    setContextMenu(null);
    if (
      !window.confirm(
        `Remove "${sourceName}"? This will delete the data source and its DuckDB table.`,
      )
    ) {
      return;
    }
    void (async () => {
      try {
        await window.duckspace.catalog.removeSource(sourceId);
        await db.data_sources.delete(sourceId);
        setRemoveError(null);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to remove data source.';
        setRemoveError(message);
      }
    })();
  }, []);

  /** Retry import for a failed or stale source. */
  const handleRetryImport = useCallback((source: DataSource): void => {
    setContextMenu(null);
    void window.duckspace.ingestion
      .importFiles([source.filePath], 'retry', source.id)
      .catch((err: unknown) => {
        console.error('[CatalogSidebar] Retry import failed:', err);
      });
  }, []);

  /** WAI-ARIA menu keyboard navigation handler. */
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      setContextMenu(null);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const current = document.activeElement as HTMLElement | null;
    const idx = current ? [...items].indexOf(current) : -1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[idx < items.length - 1 ? idx + 1 : 0]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[idx > 0 ? idx - 1 : items.length - 1]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  /** Copy the DuckDB table name to the system clipboard. */
  const handleCopyTableName = useCallback((tableName: string): void => {
    setContextMenu(null);
    void navigator.clipboard.writeText(tableName).catch((err: unknown) => {
      console.error('[CatalogSidebar] Clipboard write failed:', err);
    });
  }, []);

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
      })().catch((err: unknown) => {
        console.error('[CatalogSidebar] Source click handler failed:', err);
      });
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
                  void window.duckspace.ingestion
                    .importFiles([], 'file_picker')
                    .catch((err: unknown) => {
                      console.error('[CatalogSidebar] Import files failed:', err);
                    });
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
              onContextMenu={(e) => {
                handleContextMenu(e, source);
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
      {removeError && (
        <div
          role="alert"
          style={styles.errorBanner}
          onClick={() => {
            setRemoveError(null);
          }}
          onKeyDown={() => {
            /* click handler is primary */
          }}
        >
          {removeError}
        </div>
      )}
      {contextMenu &&
        (() => {
          const targetSource = sources?.find((s) => s.id === contextMenu.sourceId);
          if (!targetSource) return null;
          const canRetry = targetSource.status === 'error' || targetSource.status === 'stale';
          const tableName = targetSource.duckdbTableName;
          const itemCount = (tableName != null ? 1 : 0) + (canRetry ? 1 : 0) + 1;
          const menuWidth = 160;
          const menuHeight = itemCount * 32 + 8;
          const x = Math.min(contextMenu.x, window.innerWidth - menuWidth - 8);
          const y = Math.min(contextMenu.y, window.innerHeight - menuHeight - 8);
          return (
            <div
              ref={menuRef}
              role="menu"
              aria-label="Source actions"
              style={{
                ...styles.contextMenu,
                top: y,
                left: x,
              }}
              onClick={(e) => {
                e.stopPropagation();
              }}
              onKeyDown={handleMenuKeyDown}
            >
              {tableName != null && (
                <button
                  role="menuitem"
                  type="button"
                  style={styles.contextMenuItem}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#1f2937';
                  }}
                  onClick={() => {
                    handleCopyTableName(tableName);
                  }}
                >
                  Copy Table Name
                </button>
              )}
              {canRetry && (
                <button
                  role="menuitem"
                  type="button"
                  style={styles.contextMenuItem}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f3f4f6';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#1f2937';
                  }}
                  onClick={() => {
                    handleRetryImport(targetSource);
                  }}
                >
                  Retry Import
                </button>
              )}
              <button
                role="menuitem"
                type="button"
                style={styles.contextMenuItem}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                  e.currentTarget.style.color = '#ef4444';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = '#1f2937';
                }}
                onClick={() => {
                  handleRemoveSource(targetSource.id, targetSource.name);
                }}
              >
                Remove
              </button>
            </div>
          );
        })()}
      <WatchDirConfig />
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
  contextMenu: {
    position: 'fixed' as const,
    zIndex: 1000,
    backgroundColor: '#ffffff',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    padding: 4,
    minWidth: 160,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  contextMenuItem: {
    display: 'block',
    width: '100%',
    padding: '6px 12px',
    border: 'none',
    backgroundColor: 'transparent',
    color: '#1f2937',
    fontSize: 13,
    textAlign: 'left' as const,
    cursor: 'pointer',
    borderRadius: 4,
    fontFamily: 'inherit',
    lineHeight: '20px',
  },
  errorBanner: {
    padding: '6px 12px',
    backgroundColor: '#fef2f2',
    color: '#991b1b',
    fontSize: 12,
    borderTop: '1px solid #fecaca',
    cursor: 'pointer',
  },
} satisfies Record<string, React.CSSProperties>;
