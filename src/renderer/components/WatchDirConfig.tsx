import type { AddWatchDirectoryRequest, DataSourceFormat, WatchDirectory } from '@shared/types';
import type React from 'react';
import type { ReactElement } from 'react';
import { useCallback, useState } from 'react';
import { db } from '../stores/db';
import { useWatchDirectories } from '../stores/hooks';

/**
 * Abbreviated format labels for display in compact filter badges.
 * Matches the labels used in CatalogSidebar for visual consistency.
 */
const FORMAT_LABELS: Record<DataSourceFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  parquet: 'PQT',
  json: 'JSON',
  jsonl: 'JSONL',
  xlsx: 'XLSX',
  arrow_ipc: 'ARROW',
};

/**
 * All supported data source formats for the file type filter checkboxes.
 */
const ALL_FORMATS: readonly DataSourceFormat[] = [
  'csv',
  'tsv',
  'parquet',
  'json',
  'jsonl',
  'xlsx',
  'arrow_ipc',
];

/**
 * Watch directory configuration component for managing automatic file ingestion directories.
 *
 * Displays a list of currently watched directories with status indicators, format filters,
 * and source counts. Provides an inline form for adding new directories by path, and
 * a remove button per directory entry.
 *
 * Uses the `useWatchDirectories()` Dexie reactive hook for live updates, and delegates
 * IPC calls to `window.duckspace.watch.addDirectory()` and `window.duckspace.watch.removeDirectory()`.
 *
 * @returns A section element containing the directory list and add-directory form.
 */
export function WatchDirConfig(): ReactElement {
  const directories = useWatchDirectories();
  const [isAdding, setIsAdding] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [autoReingest, setAutoReingest] = useState(false);
  const [selectedFormats, setSelectedFormats] = useState<Set<DataSourceFormat>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const handleToggleFormat = useCallback((format: DataSourceFormat): void => {
    setSelectedFormats((prev) => {
      const next = new Set(prev);
      if (next.has(format)) {
        next.delete(format);
      } else {
        next.add(format);
      }
      return next;
    });
  }, []);

  const handleAdd = useCallback(async (): Promise<void> => {
    const trimmedPath = pathInput.trim();
    if (trimmedPath.length === 0) {
      setError('Directory path is required.');
      return;
    }

    setIsSubmitting(true);
    setError(undefined);

    try {
      const options: AddWatchDirectoryRequest['options'] = {
        recursive,
        autoReingest,
        fileTypeFilter: selectedFormats.size > 0 ? Array.from(selectedFormats) : undefined,
      };

      const watchDir = await window.duckspace.watch.addDirectory(trimmedPath, options);

      // Sync to Dexie for reactive UI
      await db.watch_directories.put({
        ...watchDir,
      });

      // Reset form
      setPathInput('');
      setRecursive(true);
      setAutoReingest(false);
      setSelectedFormats(new Set());
      setIsAdding(false);
    } catch (err: unknown) {
      let message = err instanceof Error ? err.message : 'Failed to add watch directory.';
      // Strip Electron IPC wrapper and DuckspaceError class prefixes for user-friendly display
      message = message.replace(/^Error invoking remote method '[^']+': /, '');
      message = message.replace(/^DuckspaceError: /, '');
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [pathInput, recursive, autoReingest, selectedFormats]);

  const handleRemove = useCallback(async (dir: WatchDirectory): Promise<void> => {
    try {
      await window.duckspace.watch.removeDirectory(dir.id);
      await db.watch_directories.delete(dir.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to remove watch directory.';
      setError(message);
    }
  }, []);

  const handleCancel = useCallback((): void => {
    setIsAdding(false);
    setPathInput('');
    setRecursive(true);
    setAutoReingest(false);
    setSelectedFormats(new Set());
    setError(undefined);
  }, []);

  return (
    <section style={styles.container} aria-label="Watch Directories">
      <div style={styles.header}>
        <h3 style={styles.title}>Watch Directories</h3>
        {!isAdding && (
          <button
            type="button"
            style={styles.addButton}
            onClick={() => {
              setIsAdding(true);
              setError(undefined);
            }}
          >
            + Add
          </button>
        )}
      </div>

      {error != null && (
        <div style={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {isAdding && (
        <div style={styles.addForm}>
          <label style={styles.fieldLabel} htmlFor="watch-dir-path">
            Directory Path
          </label>
          <input
            id="watch-dir-path"
            type="text"
            style={styles.pathInput}
            value={pathInput}
            onChange={(e) => {
              setPathInput(e.target.value);
            }}
            placeholder="/absolute/path/to/directory"
            disabled={isSubmitting}
          />

          <div style={styles.optionRow}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => {
                  setRecursive(e.target.checked);
                }}
                disabled={isSubmitting}
              />
              <span style={styles.checkboxText}>Recursive</span>
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={autoReingest}
                onChange={(e) => {
                  setAutoReingest(e.target.checked);
                }}
                disabled={isSubmitting}
              />
              <span style={styles.checkboxText}>Auto re-ingest</span>
            </label>
          </div>

          <div style={styles.formatSection}>
            <span style={styles.formatSectionLabel}>File types (empty = all):</span>
            <div style={styles.formatGrid}>
              {ALL_FORMATS.map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  aria-pressed={selectedFormats.has(fmt)}
                  style={{
                    ...styles.formatToggle,
                    ...(selectedFormats.has(fmt) ? styles.formatToggleActive : {}),
                  }}
                  onClick={() => {
                    handleToggleFormat(fmt);
                  }}
                  disabled={isSubmitting}
                >
                  {FORMAT_LABELS[fmt]}
                </button>
              ))}
            </div>
          </div>

          <div style={styles.formActions}>
            <button
              type="button"
              style={styles.cancelButton}
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              style={styles.submitButton}
              onClick={() => {
                void handleAdd();
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Adding...' : 'Add Directory'}
            </button>
          </div>
        </div>
      )}

      <div style={styles.list}>
        {!directories || directories.length === 0 ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>No watch directories configured.</p>
            <p style={styles.emptyHint}>
              Add a directory to automatically discover and ingest data files.
            </p>
          </div>
        ) : (
          directories.map((dir) => (
            <div key={dir.id} style={styles.dirItem} title={dir.path}>
              <span
                role="img"
                style={{
                  ...styles.statusDot,
                  backgroundColor: dir.isActive ? '#10b981' : '#6b7280',
                }}
                aria-label={`Status: ${dir.isActive ? 'active' : 'inactive'}`}
              />
              <div style={styles.dirInfo}>
                <span style={styles.dirName}>{dir.displayName}</span>
                <span style={styles.dirPath}>{dir.path}</span>
                <div style={styles.dirMeta}>
                  <span style={styles.sourceCount}>
                    {dir.sourceCount} {dir.sourceCount === 1 ? 'source' : 'sources'}
                  </span>
                  {dir.fileTypeFilter.length > 0 && (
                    <span style={styles.filterList}>
                      {dir.fileTypeFilter.map((f) => FORMAT_LABELS[f]).join(', ')}
                    </span>
                  )}
                  {dir.recursive && <span style={styles.dirTag}>recursive</span>}
                  {dir.autoReingest && <span style={styles.dirTag}>auto-reingest</span>}
                </div>
              </div>
              <button
                type="button"
                style={styles.removeButton}
                onClick={() => {
                  void handleRemove(dir);
                }}
                aria-label={`Remove watch directory ${dir.displayName}`}
                title="Remove watch directory"
              >
                &times;
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    backgroundColor: '#111827',
    color: '#f9fafb',
    borderRadius: 8,
    border: '1px solid #1f2937',
    overflow: 'hidden' as const,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 12px 8px',
    borderBottom: '1px solid #1f2937',
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    margin: 0,
    color: '#e5e7eb',
    letterSpacing: '0.01em',
  },
  addButton: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #3b82f6',
    borderRadius: 6,
    backgroundColor: '#3b82f6',
    color: '#ffffff',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    lineHeight: '18px',
    fontFamily: 'inherit',
  },
  errorBanner: {
    padding: '8px 12px',
    fontSize: 12,
    color: '#fca5a5',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderBottom: '1px solid #1f2937',
  },
  addForm: {
    padding: '12px',
    borderBottom: '1px solid #1f2937',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#9ca3af',
  },
  pathInput: {
    padding: '6px 8px',
    fontSize: 13,
    fontFamily: 'inherit',
    border: '1px solid #374151',
    borderRadius: 4,
    backgroundColor: '#1f2937',
    color: '#f9fafb',
    outline: 'none' as const,
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  optionRow: {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    fontSize: 12,
    color: '#d1d5db',
  },
  checkboxText: {
    fontSize: 12,
    color: '#d1d5db',
  },
  formatSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  formatSectionLabel: {
    fontSize: 12,
    color: '#9ca3af',
  },
  formatGrid: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
  },
  formatToggle: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 4,
    backgroundColor: '#374151',
    color: '#9ca3af',
    border: '1px solid #4b5563',
    cursor: 'pointer',
    letterSpacing: '0.03em',
    lineHeight: '16px',
    fontFamily: 'inherit',
  },
  formatToggleActive: {
    backgroundColor: '#1e3a5f',
    color: '#60a5fa',
    borderColor: '#3b82f6',
  },
  formActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  cancelButton: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #4b5563',
    borderRadius: 6,
    backgroundColor: 'transparent',
    color: '#9ca3af',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  submitButton: {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 600,
    border: '1px solid #3b82f6',
    borderRadius: 6,
    backgroundColor: '#3b82f6',
    color: '#ffffff',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  list: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '4px 0',
  },
  empty: {
    padding: '24px 16px',
    textAlign: 'center' as const,
  },
  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
    margin: '0 0 8px',
  },
  emptyHint: {
    fontSize: 12,
    color: '#6b7280',
    margin: 0,
  },
  dirItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    width: '100%',
    padding: '8px 12px',
    borderBottom: '1px solid #1f2937',
  },
  statusDot: {
    width: 8,
    height: 8,
    minWidth: 8,
    borderRadius: '50%',
    flexShrink: 0,
    marginTop: 5,
  },
  dirInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 0,
    gap: 2,
  },
  dirName: {
    fontWeight: 600,
    fontSize: 13,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    color: '#f9fafb',
  },
  dirPath: {
    fontSize: 11,
    color: '#6b7280',
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  },
  dirMeta: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 6,
    marginTop: 2,
  },
  sourceCount: {
    fontSize: 11,
    color: '#9ca3af',
  },
  filterList: {
    fontSize: 10,
    color: '#60a5fa',
    fontWeight: 600,
  },
  dirTag: {
    fontSize: 10,
    fontWeight: 600,
    padding: '0px 6px',
    borderRadius: 4,
    backgroundColor: '#374151',
    color: '#d1d5db',
    letterSpacing: '0.03em',
    lineHeight: '16px',
  },
  removeButton: {
    flexShrink: 0,
    width: 24,
    height: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 4,
    backgroundColor: 'transparent',
    color: '#6b7280',
    cursor: 'pointer',
    fontSize: 18,
    lineHeight: '1',
    fontFamily: 'inherit',
    padding: 0,
  },
} satisfies Record<string, React.CSSProperties>;
