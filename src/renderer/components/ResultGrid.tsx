import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { decodeArrowBatch, mergeBatches, type DecodedBatch } from '../lib/arrow-decode';
import type { ArrowBatch } from '@shared/types';

interface ResultGridProps {
  queryId: string | null;
}

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;

function ResultGrid({ queryId }: ResultGridProps) {
  const [batches, setBatches] = useState<DecodedBatch[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  // Reset batches when queryId changes
  useEffect(() => {
    setBatches([]);
    setScrollTop(0);
  }, [queryId]);

  // Listen for Arrow batch events
  useEffect(() => {
    if (!queryId) return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ queryId: string; batch: ArrowBatch }>).detail;
      if (detail.queryId !== queryId) return;

      const decoded = decodeArrowBatch(detail.batch.buffer);
      setBatches((prev) => [...prev, decoded]);
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

    const observer = new ResizeObserver((entries) => {
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
  const totalHeight = merged ? merged.rowCount * ROW_HEIGHT : 0;
  const endRow = merged ? Math.min(startRow + visibleRows, merged.rowCount) : 0;
  const topSpacerHeight = startRow * ROW_HEIGHT;
  const bottomSpacerHeight = merged
    ? Math.max(0, (merged.rowCount - endRow) * ROW_HEIGHT)
    : 0;

  // Empty state
  if (!queryId && batches.length === 0) {
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
                          key={colIndex}
                          style={{
                            padding: '2px 12px',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: 300,
                            textAlign: isNumber ? 'right' : 'left',
                            ...(isNull
                              ? { color: '#9ca3af', fontStyle: 'italic' }
                              : {}),
                          }}
                        >
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

export default ResultGrid;
