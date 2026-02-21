import type { ColumnStatisticsRecord, DataSource } from '@shared/types';
import type React from 'react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { db } from '../stores/db';
import { useColumnStats, useDataSource } from '../stores/hooks';
import { ColumnStats } from './ColumnStats';

/** Format a file size in bytes to a human-readable string. */
function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Abbreviated format labels. */
const FORMAT_LABELS: Record<DataSource['format'], string> = {
  csv: 'CSV',
  tsv: 'TSV',
  parquet: 'Parquet',
  json: 'JSON',
  jsonl: 'JSONL',
  xlsx: 'Excel',
  arrow_ipc: 'Arrow IPC',
};

/** Status color mapping. */
const STATUS_COLORS: Record<DataSource['status'], string> = {
  active: '#10b981',
  importing: '#f59e0b',
  stale: '#f59e0b',
  error: '#ef4444',
  removed: '#6b7280',
};

/**
 * Source detail panel showing metadata (name, path, format, status, row/column count,
 * file size, timestamps) and per-column statistics via ColumnStats integration.
 *
 * Includes a "Compute Stats" button that triggers `catalog.getColumnStats()` via IPC,
 * stores results in Dexie `column_statistics`, and auto-computes on first view.
 *
 * @param props.dataSourceId - The data source to display details for.
 */
export function SourceDetail({ dataSourceId }: { readonly dataSourceId: string }): ReactElement {
  const source = useDataSource(dataSourceId);
  const columnStats = useColumnStats(dataSourceId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [durationMs, setDurationMs] = useState<number | undefined>();

  const computeStats = useCallback(async () => {
    if (!source?.duckdbTableName) return;
    setLoading(true);
    setError(undefined);

    try {
      const response = await window.datspace.catalog.getColumnStats(
        dataSourceId,
        true,
        source.duckdbTableName,
      );

      // Store results in Dexie column_statistics table
      await db.transaction('rw', db.column_statistics, async () => {
        // Clear old stats for this source
        await db.column_statistics.where('dataSourceId').equals(dataSourceId).delete();

        // Bulk-add new stats
        const records: ColumnStatisticsRecord[] = response.columns.map(
          (col: ColumnStatisticsRecord) => ({
            ...col,
            id: col.id,
            dataSourceId,
          }),
        );

        await db.column_statistics.bulkAdd(records);
      });

      setDurationMs(response.durationMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [dataSourceId, source?.duckdbTableName]);

  // Auto-compute stats on first view when no cached stats exist
  const [autoComputed, setAutoComputed] = useState(false);
  useEffect(() => {
    if (!autoComputed && source?.status === 'active' && columnStats?.length === 0 && !loading) {
      setAutoComputed(true);
      void computeStats();
    }
  }, [autoComputed, source?.status, columnStats?.length, loading, computeStats]);

  if (!source) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading source details...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Source metadata header */}
      <div style={styles.metadataSection}>
        <div style={styles.nameRow}>
          <h3 style={styles.sourceName}>{source.name}</h3>
          <span
            style={{
              ...styles.statusBadge,
              backgroundColor: STATUS_COLORS[source.status],
            }}
          >
            {source.status}
          </span>
          <span style={styles.formatBadge}>{FORMAT_LABELS[source.format]}</span>
        </div>

        <div style={styles.metadataGrid}>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>File Path</span>
            <span style={styles.metaValue} title={source.filePath}>
              {source.filePath}
            </span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Rows</span>
            <span style={styles.metaValue}>
              {source.rowCount != null ? source.rowCount.toLocaleString() : '-'}
            </span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Columns</span>
            <span style={styles.metaValue}>
              {source.columnCount != null ? source.columnCount.toLocaleString() : '-'}
            </span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>File Size</span>
            <span style={styles.metaValue}>{formatFileSize(source.fileSizeBytes)}</span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Imported</span>
            <span style={styles.metaValue}>{new Date(source.createdAt).toLocaleString()}</span>
          </div>
          <div style={styles.metaItem}>
            <span style={styles.metaLabel}>Updated</span>
            <span style={styles.metaValue}>{new Date(source.updatedAt).toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Column statistics section */}
      <div style={styles.statsSection}>
        <div style={styles.statsHeader}>
          <h4 style={styles.statsTitle}>Column Statistics</h4>
          <button
            type="button"
            style={styles.computeButton}
            onClick={() => {
              void computeStats();
            }}
            disabled={loading || source.status !== 'active'}
          >
            {loading
              ? 'Computing...'
              : columnStats && columnStats.length > 0
                ? 'Recompute'
                : 'Compute Stats'}
          </button>
        </div>

        {durationMs !== undefined && (
          <span style={styles.durationText}>Computed in {(durationMs / 1000).toFixed(2)}s</span>
        )}

        {error && <div style={styles.errorBanner}>{error}</div>}

        {loading && (
          <div style={styles.loadingSpinner}>
            <span style={styles.spinnerText}>Computing column statistics...</span>
          </div>
        )}

        {!loading && columnStats && columnStats.length > 0 && (
          <div style={styles.columnList}>
            {columnStats.map((stat) => (
              <ColumnStats key={stat.id} stat={stat} />
            ))}
          </div>
        )}

        {!loading && (!columnStats || columnStats.length === 0) && !error && (
          <div style={styles.emptyStats}>
            <p style={styles.emptyText}>
              No statistics computed yet. Click "Compute Stats" to profile this data source.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    padding: 16,
    overflowY: 'auto' as const,
    height: '100%',
    backgroundColor: '#ffffff',
  },
  loading: {
    padding: 24,
    textAlign: 'center' as const,
    color: '#9ca3af',
    fontSize: 14,
  },
  metadataSection: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottom: '1px solid #e5e7eb',
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sourceName: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
    color: '#111827',
  },
  statusBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    color: '#ffffff',
    textTransform: 'capitalize' as const,
  },
  formatBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    backgroundColor: '#f3f4f6',
    color: '#374151',
  },
  metadataGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 8,
  },
  metaItem: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 2,
  },
  metaLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: '#6b7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  metaValue: {
    fontSize: 13,
    color: '#1f2937',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  statsSection: {
    marginBottom: 16,
  },
  statsHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  statsTitle: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#111827',
  },
  computeButton: {
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    color: '#374151',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  durationText: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 8,
    display: 'block',
  },
  errorBanner: {
    padding: '8px 12px',
    borderRadius: 6,
    backgroundColor: '#fef2f2',
    color: '#dc2626',
    fontSize: 12,
    marginBottom: 8,
    border: '1px solid #fecaca',
  },
  loadingSpinner: {
    padding: 24,
    textAlign: 'center' as const,
  },
  spinnerText: {
    fontSize: 13,
    color: '#6b7280',
  },
  columnList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  emptyStats: {
    padding: 24,
    textAlign: 'center' as const,
  },
  emptyText: {
    fontSize: 13,
    color: '#9ca3af',
    margin: 0,
  },
} satisfies Record<string, React.CSSProperties>;
