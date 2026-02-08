import type {
  CatalogSourceUpdatedEvent,
  DataSource,
  IngestionCompleteEvent,
  IngestionJob,
  IngestionProgressEvent,
} from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { CatalogBrowser } from './components/CatalogBrowser';
import { CatalogSidebar } from './components/CatalogSidebar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IngestionProgress } from './components/IngestionProgress';
import { QueryEditor } from './components/QueryEditor';
import { ResultGrid } from './components/ResultGrid';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { WelcomeView } from './components/WelcomeView';
import { db } from './stores/db';
import { useActiveTab, useTabs } from './stores/hooks';

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

  // Listen for ingestion push events and update Dexie state
  // QA-014: Progress/complete events may arrive before ImportFilesResponse creates
  // the Dexie record. Progress drops are acceptable (subsequent ones will land).
  // Complete events retry once after a short delay to avoid losing terminal state.
  useEffect(() => {
    const unsubProgress = window.datspace.ingestion.onProgress((event: IngestionProgressEvent) => {
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

    const unsubComplete = window.datspace.ingestion.onComplete((event: IngestionCompleteEvent) => {
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

      // Update data source status on completion
      if (event.status === 'completed') {
        void db.data_sources.update(event.dataSourceId, {
          status: 'active' as DataSource['status'],
          rowCount: event.rowCount,
          columnCount: event.columnCount,
          updatedAt: new Date().toISOString(),
        });
      }
    });

    const unsubSourceUpdated = window.datspace.catalog.onSourceUpdated(
      (event: CatalogSourceUpdatedEvent) => {
        void db.data_sources.where('id').equals(event.dataSourceId).modify({
          status: event.status,
          updatedAt: new Date().toISOString(),
        });
      },
    );

    return () => {
      unsubProgress();
      unsubComplete();
      unsubSourceUpdated();
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
          <div style={styles.placeholder}>
            <span style={styles.placeholderText}>Data Grid (coming in US2)</span>
          </div>
        );
      case 'settings':
        return (
          <div style={styles.placeholder}>
            <span style={styles.placeholderText}>Settings</span>
          </div>
        );
      default:
        return <WelcomeView />;
    }
  };

  return (
    <ErrorBoundary>
      <div style={styles.container}>
        <TabBar />
        <div style={styles.body}>
          <CatalogSidebar />
          <main style={styles.main}>{renderContent()}</main>
        </div>
        <StatusBar />
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
