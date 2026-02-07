import type { Tab } from '@shared/types';
import type React from 'react';
import { db } from '../stores/db';
import { useTabs } from '../stores/hooks';

const typeIcons: Record<Tab['type'], string> = {
  query: 'Q',
  catalog: 'C',
  settings: 'S',
};

/**
 * Horizontal tab bar that displays open workspace tabs with activate, close, and create controls.
 * Supports query, catalog, and settings tab types with type-specific icons.
 *
 * @returns The rendered tab bar element.
 */
export function TabBar(): React.JSX.Element {
  const tabs = useTabs();

  const activateTab = async (tabId: string): Promise<void> => {
    await db.transaction('rw', db.tabs, async () => {
      await db.tabs.toCollection().modify({ active: false });
      await db.tabs.update(tabId, { active: true });
    });
  };

  const closeTab = async (tabId: string): Promise<void> => {
    if (!tabs) return;

    const closingTab = tabs.find((t) => t.id === tabId);
    if (!closingTab) return;

    await db.transaction('rw', db.tabs, async () => {
      await db.tabs.delete(tabId);

      const remaining = tabs.filter((t) => t.id !== tabId);

      if (closingTab.active && remaining.length > 0) {
        // Activate nearest tab: prefer the one at the same index, else the last one
        const closedIndex = tabs.indexOf(closingTab);
        const nearestIndex = Math.min(closedIndex, remaining.length - 1);
        const nearestTab = remaining[nearestIndex];
        if (nearestTab) {
          await db.tabs.update(nearestTab.id, { active: true });
        }
      }

      // Reorder remaining tabs
      const reordered = remaining.sort((a, b) => a.order - b.order);
      for (let i = 0; i < reordered.length; i++) {
        const tab = reordered[i];
        if (tab) {
          await db.tabs.update(tab.id, { order: i });
        }
      }
    });
  };

  const createTab = async (): Promise<void> => {
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
  };

  return (
    <div
      className="drag-region"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#f3f4f6',
        borderBottom: '1px solid #e5e7eb',
        paddingLeft: 76,
        height: 36,
        overflowX: 'auto',
      }}
    >
      {tabs?.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="no-drag"
          onClick={() => {
            void activateTab(tab.id);
          }}
          style={{
            padding: '4px 12px',
            cursor: 'pointer',
            fontSize: 13,
            border: 'none',
            backgroundColor: tab.active ? 'white' : 'transparent',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            borderBottom: `2px solid ${tab.active ? '#3b82f6' : 'transparent'}`,
            height: '100%',
            fontWeight: tab.active ? 600 : 'normal',
          }}
        >
          <span>{typeIcons[tab.type]}</span>
          <span>{tab.title}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void closeTab(tab.id);
            }}
            style={{
              width: 16,
              height: 16,
              backgroundColor: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 10,
              opacity: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '1';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '0.5';
            }}
          >
            x
          </button>
        </button>
      ))}
      <button
        type="button"
        className="no-drag"
        onClick={() => {
          void createTab();
        }}
        style={{
          padding: '4px 8px',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 16,
          color: '#6b7280',
        }}
      >
        +
      </button>
    </div>
  );
}
