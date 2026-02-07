import React, { useState, useEffect, useCallback } from 'react';
import TabBar from './components/TabBar';
import StatusBar from './components/StatusBar';
import WelcomeView from './components/WelcomeView';
import QueryEditor from './components/QueryEditor';
import ResultGrid from './components/ResultGrid';
import CatalogBrowser from './components/CatalogBrowser';
import { useActiveTab, useTabs } from './stores/hooks';
import db from './stores/db';

export default function App() {
  const tabs = useTabs();
  const activeTab = useActiveTab();
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);

  // T065: Keyboard shortcuts
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
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
          await db.tabs.update(remaining[nearestIndex].id, { active: true });
        }
        const reordered = tabs.filter((t) => t.id !== active.id).sort((a, b) => a.order - b.order);
        for (let i = 0; i < reordered.length; i++) {
          await db.tabs.update(reordered[i].id, { order: i });
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
      await db.transaction('rw', db.tabs, async () => {
        await db.tabs.toCollection().modify({ active: false });
        await db.tabs.update(sorted[prevIdx].id, { active: true });
      });
      return;
    }

    // Cmd+Shift+] : Next tab
    if (meta && e.shiftKey && e.key === ']') {
      e.preventDefault();
      if (!tabs || tabs.length < 2) return;
      const sorted = [...tabs].sort((a, b) => a.order - b.order);
      const activeIdx = sorted.findIndex((t) => t.active);
      const nextIdx = activeIdx >= sorted.length - 1 ? 0 : activeIdx + 1;
      await db.transaction('rw', db.tabs, async () => {
        await db.tabs.toCollection().modify({ active: false });
        await db.tabs.update(sorted[nextIdx].id, { active: true });
      });
      return;
    }
  }, [tabs]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const renderContent = () => {
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
            <ResultGrid queryId={activeQueryId} />
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
      <main style={styles.main}>
        {renderContent()}
      </main>
      <StatusBar />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#1f2937',
    backgroundColor: '#ffffff',
  },
  main: {
    flex: 1,
    overflow: 'auto',
    position: 'relative',
  },
  queryLayout: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
  },
  placeholder: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: '#9ca3af',
  },
  placeholderText: {
    fontSize: 16,
    fontWeight: 500,
  },
};
