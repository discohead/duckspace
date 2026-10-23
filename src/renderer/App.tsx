import type {
  CatalogSourceUpdatedEvent,
  DataSource,
  IngestionCompleteEvent,
  IngestionJob,
  IngestionProgressEvent,
  WatchFileEvent,
} from '@shared/types';
import { assertNever } from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { CatalogBrowser } from './components/CatalogBrowser';
import { CatalogSidebar } from './components/CatalogSidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IngestionProgress } from './components/IngestionProgress';
import { QueryEditor } from './components/QueryEditor';
import { ResultGrid } from './components/ResultGrid';
import { SourceDetail } from './components/SourceDetail';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { WelcomeView } from './components/WelcomeView';

// Lazy-load DataGrid to avoid blocking startup with Perspective WASM initialization
const DataGrid = lazy(() => import('./components/DataGrid').then((m) => ({ default: m.DataGrid })));

import { db } from './stores/db';
import { useActiveTab, useTabs, useWorkerHealth } from './stores/hooks';

/**
 * Root application component that renders the tab bar, main content area, and status bar.
 * Manages keyboard shortcuts for tab navigation and delegates content rendering based on active tab type.
 */
export function App(): ReactElement {
  const tabs = useTabs();
  const activeTab = useActiveTab();

  // QA-015: Prevent concurrent Cmd+T from creating tabs with duplicate order values
  const isCreatingTabRef = useRef(false);

  // T065: Keyboard shortcuts
  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+T: New tab
      if (meta && e.key === 't') {
        e.preventDefault();
        if (isCreatingTabRef.current) return;
        isCreatingTabRef.current = true;
        try {
          const maxOrder = tabs ? tabs.reduce((max, t) => Math.max(max, t.order), -1) : -1;
          const queryCount = tabs ? tabs.filter((t) => t.type === 'query').length : 0;
          await db.transaction('rw', db.tabs, async () => {
            await db.tabs.toCollection().modify({ active: false });
            await db.tabs.add({
              id: crypto.randomUUID(),
              type: 'query',
              order: maxOrder + 1,
              title: `Query ${queryCount + 1}`,
              active: true,
              state: { sql: '' },
              lastAccessedAt: new Date().toISOString(),
            });
          });
        } finally {
          isCreatingTabRef.current = false;
        }
        return;
      }

      // Cmd+W: Close active tab
      if (meta && e.key === 'w') {
        e.preventDefault();
        if (!tabs || tabs.length === 0) return;
        const active = tabs.find((t) => t.active);
        if (!active) return;

        await db.transaction('rw', db.tabs, async () => {
          await db.tabs.delete(active.id);
          const remaining = tabs.filter((t) => t.id !== active.id);
          if (remaining.length > 0) {
            const closedIndex = tabs.indexOf(active);
            const nearestIndex = Math.min(closedIndex, remaining.length - 1);
            const nearestTab = remaining[nearestIndex];
            if (nearestTab) {
              await db.tabs.update(nearestTab.id, { active: true });
            }
          }
          const reordered = tabs
            .filter((t) => t.id !== active.id)
            .sort((a, b) => a.order - b.order);
          for (let i = 0; i < reordered.length; i++) {
            const tab = reordered[i];
            if (tab) {
              await db.tabs.update(tab.id, { order: i });
            }
          }
        });
        return;
      }

      // Cmd+Shift+[ : Previous tab
      if (meta && e.shiftKey && e.key === '[') {
        e.preventDefault();
        if (!tabs || tabs.length < 2) return;
        const sorted = [...tabs].sort((a, b) => a.order - b.order);
        const activeIdx = sorted.findIndex((t) => t.active);
        const prevIdx = activeIdx <= 0 ? sorted.length - 1 : activeIdx - 1;
        const prevTab = sorted[prevIdx];
        if (prevTab) {
          await db.transaction('rw', db.tabs, async () => {
            await db.tabs.toCollection().modify({ active: false });
            await db.tabs.update(prevTab.id, { active: true });
          });
        }
        return;
      }

      // Cmd+Shift+] : Next tab
      if (meta && e.shiftKey && e.key === ']') {
        e.preventDefault();
        if (!tabs || tabs.length < 2) return;
        const sorted = [...tabs].sort((a, b) => a.order - b.order);
        const activeIdx = sorted.findIndex((t) => t.active);
        const nextIdx = activeIdx >= sorted.length - 1 ? 0 : activeIdx + 1;
        const nextTab = sorted[nextIdx];
        if (nextTab) {
          await db.transaction('rw', db.tabs, async () => {
            await db.tabs.toCollection().modify({ active: false });
            await db.tabs.update(nextTab.id, { active: true });
          });
        }
        return;
      }
    },
    [tabs],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      void handleKeyDown(e);
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [handleKeyDown]);

  // On startup, clean up stale Dexie state from previous sessions:
  // 1. Mark 'importing' data sources as 'error' (interrupted imports)
  // 2. Mark 'running'/'queued' ingestion jobs as 'failed'
  // (Dexie-only operations — safe to run immediately on mount)
  useEffect(() => {
    void db.data_sources
      .where('status')
      .equals('importing')
      .modify({
        status: 'error' as DataSource['status'],
        updatedAt: new Date().toISOString(),
      })
      .catch((err: unknown) => {
        console.error('[App] Failed to clean up stale data sources:', err);
      });
    void db.ingestion_jobs
      .where('status')
      .anyOf('running', 'queued')
      .modify({
        status: 'failed' as IngestionJob['status'],
        completedAt: new Date().toISOString(),
      })
      .catch((err: unknown) => {
        console.error('[App] Failed to clean up stale ingestion jobs:', err);
      });
  }, []);

  // Verify 'active' data sources have matching DuckDB tables (handles
  // DB deletion between sessions) — mark orphaned ones as 'stale'.
  //
  // This check is deferred until the DuckDB worker reports 'ready' status,
  // because the mount useEffect fires before Main pushes the initial worker
  // health (step 8 of the startup sequence). Without this gate, listTables()
  // could fail or return empty results, falsely marking valid sources as stale.
  const workerHealth = useWorkerHealth();
  const [staleCheckDone, setStaleCheckDone] = useState(false);

  useEffect(() => {
    if (staleCheckDone) return;
    if (workerHealth?.status !== 'ready') return;
    setStaleCheckDone(true);

    void (async () => {
      try {
        const activeSources = await db.data_sources.where('status').equals('active').toArray();
        if (activeSources.length === 0) return;

        const catalogEntries = await window.duckspace.catalog.listTables();
        const duckdbTableNames = new Set(catalogEntries.map((e) => e.name));

        for (const source of activeSources) {
          const found = source.duckdbTableName
            ? duckdbTableNames.has(source.duckdbTableName)
            : false;
          if (source.duckdbTableName && !found) {
            await db.data_sources.update(source.id, {
              status: 'stale' as DataSource['status'],
              updatedAt: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        console.error('[stale-check] error:', err);
      }
    })();
  }, [workerHealth?.status, staleCheckDone]);

  // Listen for ingestion push events and update Dexie state.
  // The ingestion-router sends full DataSource/IngestionJob objects in initial
  // push events, which we use to CREATE Dexie records. Subsequent events UPDATE them.
  useEffect(() => {
    const unsubProgress = window.duckspace.ingestion.onProgress((event: IngestionProgressEvent) => {
      // The initial progress event from importFiles() includes a full IngestionJob
      // object. Use it to create the Dexie record. Subsequent progress events
      // only include partial update fields.
      const rawEvent = event as IngestionProgressEvent & {
        readonly ingestionJob?: IngestionJob;
      };
      if (rawEvent.ingestionJob) {
        void db.ingestion_jobs.put(rawEvent.ingestionJob);
        return;
      }

      void db.ingestion_jobs.update(event.jobId, {
        status: 'running' as IngestionJob['status'],
        rowsProcessed: event.rowsProcessed,
        bytesProcessed: event.bytesProcessed,
        estimatedTotalRows: event.estimatedTotalRows,
      });
    });

    const applyComplete = async (event: IngestionCompleteEvent): Promise<number> => {
      const updated = await db.ingestion_jobs.update(event.jobId, {
        status: event.status as IngestionJob['status'],
        completedAt: new Date().toISOString(),
        durationMs: event.durationMs,
        errorMessage: event.errorMessage,
      });
      return typeof updated === 'number' ? updated : 1;
    };

    const unsubComplete = window.duckspace.ingestion.onComplete((event: IngestionCompleteEvent) => {
      void (async () => {
        const updated = await applyComplete(event);
        if (updated === 0) {
          // Record not yet created — retry once after a short delay
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
          });
          await applyComplete(event);
        }
      })();

      // Update data source status on completion or failure
      if (event.dataSourceId) {
        if (event.status === 'completed') {
          void db.data_sources.update(event.dataSourceId, {
            status: 'active' as DataSource['status'],
            rowCount: event.rowCount,
            columnCount: event.columnCount,
            updatedAt: new Date().toISOString(),
          });
        } else if (event.status === 'failed') {
          void db.data_sources.update(event.dataSourceId, {
            status: 'error' as DataSource['status'],
            updatedAt: new Date().toISOString(),
          });
        }
      }
    });

    const unsubSourceUpdated = window.duckspace.catalog.onSourceUpdated(
      (event: CatalogSourceUpdatedEvent) => {
        // The ingestion pipeline sends source_created events with a full DataSource
        // object. Use it to create the Dexie record. Standard status update events
        // only include dataSourceId and status.
        const rawEvent = event as CatalogSourceUpdatedEvent & {
          readonly dataSource?: DataSource;
        };
        if (rawEvent.dataSource) {
          void db.data_sources.put(rawEvent.dataSource);
          return;
        }

        void db.data_sources.where('id').equals(event.dataSourceId).modify({
          status: event.status,
          updatedAt: new Date().toISOString(),
        });
      },
    );

    // T038: Listen for watch:fileEvent push events from the file watcher.
    // Update sourceCount on 'add'/'unlink' events for the originating watch directory.
    const unsubWatchFileEvent = window.duckspace.watch.onFileEvent((event: WatchFileEvent) => {
      if (event.eventType === 'add' || event.eventType === 'unlink') {
        const delta = event.eventType === 'add' ? 1 : -1;
        // Use .modify() callback for atomic read-modify-write within a single
        // IndexedDB transaction, preventing race conditions when multiple file
        // events arrive concurrently (e.g. two CSVs discovered simultaneously).
        void db.watch_directories
          .where('id')
          .equals(event.watchDirectoryId)
          .modify((dir: { sourceCount: number; updatedAt: string }) => {
            dir.sourceCount = Math.max(0, dir.sourceCount + delta);
            dir.updatedAt = new Date().toISOString();
          })
          .then((updated) => {
            if (updated === 0) {
              console.warn(`[App:watch] No watch directory found for id=${event.watchDirectoryId}`);
            }
          });
      }
    });

    // Restore previously configured watch directories on startup
    void (async () => {
      try {
        const dirs = await db.watch_directories.filter((d) => d.isActive).toArray();
        console.log(`[App:watch] Restoring ${String(dirs.length)} active watch directories`);
        if (dirs.length > 0) {
          const restored = await window.duckspace.watch.restoreDirectories(dirs);
          console.log(
            `[App:watch] Restored ${String(restored)}/${String(dirs.length)} directories`,
          );

          // Recount sourceCount from actual data_sources records to fix stale
          // counts from previous sessions. restoreDirectories uses ignoreInitial:
          // true so no 'add' events fire for existing files — the persisted
          // sourceCount from last session may be wrong if files were added/removed
          // while the app was closed.
          for (const dir of dirs) {
            const sources = await db.data_sources
              .filter((s) => s.watchDirectoryId === dir.id)
              .count();
            if (sources !== dir.sourceCount) {
              console.log(
                `[App:watch] Correcting sourceCount for "${dir.displayName}": ${String(dir.sourceCount)} → ${String(sources)}`,
              );
              await db.watch_directories.update(dir.id, {
                sourceCount: sources,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        }
      } catch (err: unknown) {
        console.warn('[App:watch] Failed to restore watch directories:', err);
      }
    })();

    return () => {
      unsubProgress();
      unsubComplete();
      unsubSourceUpdated();
      unsubWatchFileEvent();
    };
  }, []);

  const renderContent = (): ReactElement => {
    if (!tabs || tabs.length === 0) {
      return <WelcomeView />;
    }

    if (!activeTab) {
      return <WelcomeView />;
    }

    switch (activeTab.type) {
      case 'query':
        return (
          <div style={styles.queryLayout}>
            <QueryEditor />
            <ResultGrid queryId={activeTab.id} />
          </div>
        );
      case 'catalog':
        return <CatalogBrowser />;
      case 'data_grid':
        return (
          <div style={styles.dataGridLayout}>
            <div style={styles.dataGridMain}>
              <Suspense
                fallback={
                  <div style={styles.placeholder}>
                    <span style={styles.placeholderText}>Loading data grid...</span>
                  </div>
                }
              >
                <DataGrid tabId={activeTab.id} tabState={activeTab.state} />
              </Suspense>
            </div>
            <div style={styles.dataGridDetail}>
              <SourceDetail dataSourceId={activeTab.state.dataSourceId} />
            </div>
          </div>
        );
      case 'settings':
        return (
          <div style={styles.placeholder}>
            <span style={styles.placeholderText}>Settings</span>
          </div>
        );
      default:
        return assertNever(activeTab);
    }
  };

  return (
    <ErrorBoundary>
      <div style={styles.container}>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <header>
          <TabBar />
        </header>
        <div style={styles.body}>
          <CatalogSidebar />
          <main id="main-content" style={styles.main}>
            {renderContent()}
          </main>
        </div>
        <footer>
          <StatusBar />
        </footer>
        <IngestionProgress />
      </div>
    </ErrorBoundary>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#1f2937',
    backgroundColor: '#ffffff',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden' as const,
  },
  main: {
    flex: 1,
    overflow: 'auto' as const,
    position: 'relative' as const,
  },
  queryLayout: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
  },
  dataGridLayout: {
    display: 'flex',
    height: '100%',
    overflow: 'hidden' as const,
  },
  dataGridMain: {
    flex: 1,
    overflow: 'hidden' as const,
    minWidth: 0,
  },
  dataGridDetail: {
    width: 320,
    borderLeft: '1px solid #e5e7eb',
    overflowY: 'auto' as const,
    flexShrink: 0,
  },
  placeholder: {
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    height: '100%',
    color: '#9ca3af',
  },
  placeholderText: {
    fontSize: 16,
    fontWeight: 500,
  },
} satisfies Record<string, React.CSSProperties>;
