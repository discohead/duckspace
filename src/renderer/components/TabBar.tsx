import type { Tab } from '@shared/types';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../stores/db';
import { useTabs } from '../stores/hooks';

const typeIcons: Record<Tab['type'], string> = {
  query: 'Q',
  catalog: 'C',
  settings: 'S',
  data_grid: 'D',
};

/** Display labels for the new-tab dropdown menu. */
const tabTypeLabels: Record<Tab['type'], string> = {
  query: 'New Query',
  catalog: 'Catalog Browser',
  settings: 'Settings',
  data_grid: 'Data Grid',
};

/**
 * Horizontal tab bar that displays open workspace tabs with activate, close, and create controls.
 * Supports query, catalog, and settings tab types with type-specific icons.
 *
 * @returns The rendered tab bar element.
 */
export function TabBar(): React.JSX.Element {
  const tabs = useTabs();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // QA-018: Refs for roving tabindex arrow key navigation
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

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

  // QA-018: Arrow key navigation for WAI-ARIA Tabs pattern
  const handleTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!tabs || tabs.length === 0) return;

      const tabIds = tabs.map((t) => t.id);
      const focusedEl = document.activeElement;
      // Find current focused tab index
      let currentIdx = -1;
      for (let i = 0; i < tabIds.length; i++) {
        const id = tabIds[i];
        if (id && tabRefs.current.get(id) === focusedEl) {
          currentIdx = i;
          break;
        }
      }
      if (currentIdx === -1) return;

      let nextIdx: number | undefined;
      if (e.key === 'ArrowRight') {
        nextIdx = currentIdx < tabs.length - 1 ? currentIdx + 1 : 0;
      } else if (e.key === 'ArrowLeft') {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : tabs.length - 1;
      } else if (e.key === 'Home') {
        nextIdx = 0;
      } else if (e.key === 'End') {
        nextIdx = tabs.length - 1;
      }

      if (nextIdx !== undefined) {
        e.preventDefault();
        const nextId = tabIds[nextIdx];
        if (nextId) {
          tabRefs.current.get(nextId)?.focus();
        }
      }
    },
    [tabs],
  );

  /** Generate a title for a new tab of the given type. */
  const generateTitle = useCallback((type: Tab['type'], currentTabs: Tab[]): string => {
    if (type === 'query') {
      return `Query ${currentTabs.filter((t) => t.type === 'query').length + 1}`;
    }
    if (type === 'catalog') return 'Catalog';
    if (type === 'data_grid') return 'Data Grid';
    return 'Settings';
  }, []);

  /** Build a properly-typed Tab record for the given type. */
  const buildTab = useCallback(
    (type: Tab['type'], currentTabs: Tab[], order: number): Tab => {
      const base = {
        id: crypto.randomUUID(),
        order,
        title: generateTitle(type, currentTabs),
        active: true as const,
        lastAccessedAt: new Date().toISOString(),
      };
      switch (type) {
        case 'query':
          return { ...base, type: 'query', state: { sql: '' } };
        case 'catalog':
          return { ...base, type: 'catalog', state: {} };
        case 'settings':
          return { ...base, type: 'settings', state: {} };
        case 'data_grid':
          return { ...base, type: 'data_grid', state: { dataSourceId: '', tableName: '' } };
      }
    },
    [generateTitle],
  );

  const createTab = async (type: Tab['type']): Promise<void> => {
    const currentTabs = await db.tabs.toArray();
    const maxOrder = currentTabs.reduce((max, t) => Math.max(max, t.order), -1);

    await db.transaction('rw', db.tabs, async () => {
      await db.tabs.toCollection().modify({ active: false });
      await db.tabs.add(buildTab(type, currentTabs, maxOrder + 1));
    });

    setShowMenu(false);
  };

  return (
    <div
      className="drag-region"
      role="tablist"
      aria-label="Open tabs"
      onKeyDown={handleTablistKeyDown}
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
        <div
          key={tab.id}
          ref={(el) => {
            if (el) {
              tabRefs.current.set(tab.id, el);
            } else {
              tabRefs.current.delete(tab.id);
            }
          }}
          role="tab"
          tabIndex={tab.active ? 0 : -1}
          aria-selected={tab.active}
          className="no-drag"
          onClick={() => {
            void activateTab(tab.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void activateTab(tab.id);
            }
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
            aria-label={`Close ${tab.title}`}
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
        </div>
      ))}

      {/* New tab button with dropdown */}
      <div ref={menuRef} className="no-drag" style={{ position: 'relative' }}>
        <button
          type="button"
          aria-label="New tab"
          aria-haspopup="true"
          aria-expanded={showMenu}
          onClick={() => {
            setShowMenu((prev) => !prev);
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

        {showMenu && (
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              zIndex: 10,
              backgroundColor: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              minWidth: 160,
              padding: '4px 0',
            }}
          >
            {(['query', 'catalog', 'settings'] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="menuitem"
                onClick={() => {
                  void createTab(type);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '8px 12px',
                  backgroundColor: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: '#374151',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#f3f4f6';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    backgroundColor: '#e5e7eb',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                >
                  {typeIcons[type]}
                </span>
                {tabTypeLabels[type]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
