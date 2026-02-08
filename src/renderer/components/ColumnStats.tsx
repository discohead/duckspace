import type { ColumnStatisticsRecord } from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';

/** Numeric DuckDB types that should show mean/median/stddev/quartile stats. */
const NUMERIC_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'FLOAT',
  'DOUBLE',
  'DECIMAL',
  'HUGEINT',
]);

/** Returns true if the column type string represents a numeric DuckDB type. */
function isNumericType(columnType: string): boolean {
  const upper = columnType.toUpperCase();
  // Handle parameterized types like DECIMAL(10,2)
  const base = upper.split('(')[0] ?? upper;
  return NUMERIC_TYPES.has(base);
}

/** Format a number for display (2 decimal places, with locale separators). */
function formatNumber(n: number | undefined): string {
  if (n === undefined) return '-';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Renders per-column statistics: data type badge, null count/percentage,
 * distinct count, numeric stats (min/max/mean/median/stddev), and
 * categorical top-10 values with frequency bars.
 *
 * @param props.stat - The column statistics record to display.
 */
export function ColumnStats({ stat }: { readonly stat: ColumnStatisticsRecord }): ReactElement {
  const numeric = isNumericType(stat.columnType) || stat.mean !== undefined;
  const nullPct = stat.nullPercentage;

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <span style={styles.columnName}>{stat.columnName}</span>
        <span style={styles.typeBadge}>{stat.columnType}</span>
      </div>

      {/* Core stats row */}
      <div style={styles.statsRow}>
        <div style={styles.statItem}>
          <span style={styles.statLabel}>Rows</span>
          <span style={styles.statValue}>{stat.rowCount.toLocaleString()}</span>
        </div>
        <div style={styles.statItem}>
          <span style={styles.statLabel}>Nulls</span>
          <span style={styles.statValue}>
            {stat.nullCount.toLocaleString()}
            <span style={styles.statPct}> ({nullPct.toFixed(1)}%)</span>
          </span>
        </div>
        <div style={styles.statItem}>
          <span style={styles.statLabel}>Distinct</span>
          <span style={styles.statValue}>{stat.distinctCount.toLocaleString()}</span>
        </div>
      </div>

      {/* Null percentage bar */}
      <div style={styles.barContainer}>
        <div style={{ ...styles.barFill, width: `${Math.min(nullPct, 100)}%` }} />
      </div>

      {/* Numeric stats */}
      {numeric && (stat.min !== undefined || stat.mean !== undefined) && (
        <div style={styles.numericSection}>
          <div style={styles.statsRow}>
            {stat.min !== undefined && (
              <div style={styles.statItem}>
                <span style={styles.statLabel}>Min</span>
                <span style={styles.statValue}>{stat.min}</span>
              </div>
            )}
            {stat.max !== undefined && (
              <div style={styles.statItem}>
                <span style={styles.statLabel}>Max</span>
                <span style={styles.statValue}>{stat.max}</span>
              </div>
            )}
          </div>
          <div style={styles.statsRow}>
            <div style={styles.statItem}>
              <span style={styles.statLabel}>Mean</span>
              <span style={styles.statValue}>{formatNumber(stat.mean)}</span>
            </div>
            <div style={styles.statItem}>
              <span style={styles.statLabel}>Median</span>
              <span style={styles.statValue}>{formatNumber(stat.median)}</span>
            </div>
            <div style={styles.statItem}>
              <span style={styles.statLabel}>Std Dev</span>
              <span style={styles.statValue}>{formatNumber(stat.stddev)}</span>
            </div>
          </div>
          {(stat.q25 !== undefined || stat.q75 !== undefined) && (
            <div style={styles.statsRow}>
              <div style={styles.statItem}>
                <span style={styles.statLabel}>Q25</span>
                <span style={styles.statValue}>{formatNumber(stat.q25)}</span>
              </div>
              <div style={styles.statItem}>
                <span style={styles.statLabel}>Q75</span>
                <span style={styles.statValue}>{formatNumber(stat.q75)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Categorical top values */}
      {stat.topValues && stat.topValues.length > 0 && (
        <div style={styles.topValuesSection}>
          <span style={styles.topValuesTitle}>Top Values</span>
          {stat.topValues.map((tv) => (
            <div key={tv.value} style={styles.topValueRow}>
              <span style={styles.topValueLabel} title={tv.value}>
                {tv.value || '(empty)'}
              </span>
              <div style={styles.topValueBarContainer}>
                <div
                  style={{
                    ...styles.topValueBarFill,
                    width: `${Math.min(tv.percentage, 100)}%`,
                  }}
                />
              </div>
              <span style={styles.topValueCount}>
                {tv.count.toLocaleString()} ({tv.percentage.toFixed(1)}%)
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  card: {
    backgroundColor: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  columnName: {
    fontWeight: 600,
    fontSize: 13,
    color: '#111827',
  },
  typeBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    backgroundColor: '#dbeafe',
    color: '#1d4ed8',
    letterSpacing: '0.02em',
  },
  statsRow: {
    display: 'flex',
    gap: 16,
    marginBottom: 4,
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 60,
  },
  statLabel: {
    fontSize: 10,
    color: '#6b7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  statValue: {
    fontSize: 13,
    fontWeight: 500,
    color: '#1f2937',
  },
  statPct: {
    fontSize: 11,
    color: '#9ca3af',
  },
  barContainer: {
    height: 4,
    backgroundColor: '#e5e7eb',
    borderRadius: 2,
    marginTop: 4,
    marginBottom: 8,
    overflow: 'hidden' as const,
  },
  barFill: {
    height: '100%',
    backgroundColor: '#f59e0b',
    borderRadius: 2,
    transition: 'width 0.3s ease',
  },
  numericSection: {
    borderTop: '1px solid #e5e7eb',
    paddingTop: 8,
    marginTop: 4,
  },
  topValuesSection: {
    borderTop: '1px solid #e5e7eb',
    paddingTop: 8,
    marginTop: 4,
  },
  topValuesTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#374151',
    marginBottom: 4,
    display: 'block',
  },
  topValueRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  },
  topValueLabel: {
    fontSize: 12,
    color: '#374151',
    width: 100,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  topValueBarContainer: {
    flex: 1,
    height: 6,
    backgroundColor: '#e5e7eb',
    borderRadius: 3,
    overflow: 'hidden' as const,
  },
  topValueBarFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: 3,
  },
  topValueCount: {
    fontSize: 11,
    color: '#6b7280',
    minWidth: 80,
    textAlign: 'right' as const,
    flexShrink: 0,
  },
} satisfies Record<string, React.CSSProperties>;
