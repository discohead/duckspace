import type { ArrowBatch } from '@shared/types';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type DecodedBatch, decodeArrowBatch, mergeBatches } from '../lib/arrow-decode';

/** Props for the {@link ResultGrid} component. */
interface ResultGridProps {
  /** The ID of the currently executing query, or null when idle. */
  queryId: string | null;
}

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;

/**
 * Virtualized data grid that displays Arrow IPC query results.
 * Listens for `datspace:arrow-batch` custom events, decodes and merges batches,
 * and renders rows with virtual scrolling for large result sets.
 *
 * @param props - Component props containing the active query ID.
 */
export function ResultGrid({ queryId }: ResultGridProps): ReactElement {
  const [batches, setBatches] = useState<DecodedBatch[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // Reset batches when queryId (tab ID) changes (i.e., tab switch)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on queryId change
  useEffect(() => {
    setBatches([]);
    setScrollTop(0);
  }, [queryId]);

  // Reset batches when a new query is executed on this tab
  useEffect(() => {
    if (!queryId) return;

    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId: string }>).detail;
      if (detail.tabId === queryId) {
        setBatches([]);
        setScrollTop(0);
      }
    };

    window.addEventListener('datspace:result-reset', handler);
    return () => {
      window.removeEventListener('datspace:result-reset', handler);
    };
  }, [queryId]);

  // Listen for Arrow batch events (filtered by tab ID passed as queryId prop)
  useEffect(() => {
    if (!queryId) return;

    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ queryId: string; batch: ArrowBatch }>).detail;
      if (detail.queryId !== queryId) return;

      if (detail.batch.isLast || detail.batch.buffer.byteLength === 0) return;
      const decoded = decodeArrowBatch(detail.batch.buffer);
      if (decoded) {
        setBatches((prev) => [...prev, decoded]);
      }
    };

    window.addEventListener('datspace:arrow-batch', handler);
    return () => {
      window.removeEventListener('datspace:arrow-batch', handler);
    };
  }, [queryId]);

  // Track container height for virtual scrolling
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });

    observer.observe(container);
    setContainerHeight(container.clientHeight);

    return () => {
      observer.disconnect();
    };
  }, []);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      setScrollTop(container.scrollTop);
    }
  }, []);

  const merged = useMemo(() => mergeBatches(batches), [batches]);

  // Virtual scroll calculations
  const startRow = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleRows = Math.ceil(containerHeight / ROW_HEIGHT) + 1;
  const endRow = merged ? Math.min(startRow + visibleRows, merged.rowCount) : 0;
  const topSpacerHeight = startRow * ROW_HEIGHT;
  const bottomSpacerHeight = merged ? Math.max(0, (merged.rowCount - endRow) * ROW_HEIGHT) : 0;

  // Empty state — show when no result batches have been received
  if (batches.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'monospace',
          fontSize: 13,
          color: '#6b7280',
        }}
      >
        Execute a query to see results
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflow: 'auto',
        position: 'relative',
        fontSize: 13,
        fontFamily: 'monospace',
      }}
    >
      {merged && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr
                style={{
                  position: 'sticky',
                  top: 0,
                  backgroundColor: '#f3f4f6',
                  zIndex: 1,
                  height: HEADER_HEIGHT,
                }}
              >
                {merged.columns.map((col, i) => (
                  <th
                    key={col}
                    style={{
                      padding: '4px 12px',
                      textAlign: 'left',
                      fontWeight: 600,
                      borderBottom: '2px solid #e5e7eb',
                      whiteSpace: 'nowrap',
                      fontSize: 12,
                      color: '#374151',
                    }}
                  >
                    {col}{' '}
                    <span style={{ fontWeight: 400, color: '#9ca3af' }}>
                      {merged.columnTypes[i]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Top spacer to maintain scroll position */}
              {topSpacerHeight > 0 && (
                <tr>
                  <td
                    colSpan={merged.columns.length}
                    style={{ height: topSpacerHeight, padding: 0, border: 'none' }}
                  />
                </tr>
              )}
              {/* Visible rows */}
              {Array.from({ length: endRow - startRow }, (_, i) => {
                const rowIndex = startRow + i;
                return (
                  <tr
                    key={rowIndex}
                    style={{
                      height: ROW_HEIGHT,
                      borderBottom: '1px solid #f3f4f6',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '#f9fafb';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.backgroundColor = '';
                    }}
                  >
                    {merged.columns.map((_, colIndex) => {
                      const value = merged.getCell(rowIndex, colIndex);
                      const isNull = value === null || value === undefined;
                      const isNumber = typeof value === 'number' || typeof value === 'bigint';

                      return (
                        <td
                          // biome-ignore lint/suspicious/noArrayIndexKey: stable column order in result grid
                          key={colIndex}
                          style={{
                            padding: '2px 12px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: 300,
                            textAlign: isNumber ? 'right' : 'left',
                            ...(isNull ? { color: '#9ca3af', fontStyle: 'italic' as const } : {}),
                          }}
                        >
                          {/* eslint-disable-next-line @typescript-eslint/no-base-to-string */}
                          {isNull ? 'NULL' : String(value)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {/* Bottom spacer to maintain scroll height */}
              {bottomSpacerHeight > 0 && (
                <tr>
                  <td
                    colSpan={merged.columns.length}
                    style={{ height: bottomSpacerHeight, padding: 0, border: 'none' }}
                  />
                </tr>
              )}
            </tbody>
          </table>
          {/* Row count footer */}
          <div
            style={{
              padding: '8px 12px',
              fontSize: 12,
              color: '#6b7280',
              backgroundColor: '#f9fafb',
              borderTop: '1px solid #e5e7eb',
              position: 'sticky',
              bottom: 0,
            }}
          >
            {merged.rowCount.toLocaleString()} row{merged.rowCount !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </div>
  );
}
