import type React from 'react';
import type { ReactElement } from 'react';
import { useCallback, useEffect } from 'react';
import { CatalogBrowser } from './components/CatalogBrowser';
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

  // T065: Keyboard shortcuts
  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+T: New tab
      if (meta && e.key === 't') {
        e.preventDefault();
        const currentTabs = await db.tabs.toArray();
        const maxOrder = currentTabs.reduce((max, t) => Math.max(max, t.order), -1);
        await db.transaction('rw', db.tabs, async () => {
          await db.tabs.toCollection().modify({ active: false });
          await db.tabs.add({
            id: crypto.randomUUID(),
            type: 'query',
            order: maxOrder + 1,
            title: `Query ${currentTabs.filter((t) => t.type === 'query').length + 1}`,
            active: true,
            state: { sql: '' },
            lastAccessedAt: new Date().toISOString(),
          });
        });
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
    <div style={styles.container}>
      <TabBar />
      <main style={styles.main}>{renderContent()}</main>
      <StatusBar />
    </div>
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
