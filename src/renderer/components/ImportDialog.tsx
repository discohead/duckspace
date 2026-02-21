import type React from 'react';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Set of file extensions supported for local data ingestion.
 * Matches against the lowercased extension (including the leading dot).
 */
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.csv',
  '.tsv',
  '.parquet',
  '.json',
  '.jsonl',
  '.ndjson',
  '.xlsx',
  '.xls',
  '.arrow',
  '.ipc',
  '.feather',
]);

/**
 * Extracts the file extension from a filename, lowercased with leading dot.
 *
 * @param name - The filename to extract the extension from.
 * @returns The lowercased extension (e.g., `.csv`), or an empty string if none found.
 */
function getExtension(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return '';
  return name.slice(lastDot).toLowerCase();
}

/**
 * Filters an array of dropped files to those with supported extensions,
 * returning their absolute paths (available via Electron's `File.path` property).
 *
 * @param files - The `FileList` from a drag-and-drop event.
 * @returns An array of absolute file paths for supported files.
 */
function extractSupportedPaths(files: FileList): string[] {
  const paths: string[] = [];
  for (const file of Array.from(files)) {
    const ext = getExtension(file.name);
    if (SUPPORTED_EXTENSIONS.has(ext)) {
      // Electron exposes the absolute file path on File objects from drag-and-drop
      const filePath = (file as File & { readonly path?: string }).path;
      if (typeof filePath === 'string') {
        paths.push(filePath);
      }
    }
  }
  return paths;
}

/**
 * Import dialog with drag-and-drop support and a file picker button.
 * Provides a full-window drop zone overlay when files are being dragged over
 * the application, and validates file extensions against supported formats
 * before initiating ingestion via the preload bridge.
 *
 * For drag-and-drop, file paths are extracted from the Electron-extended
 * `File.path` property and sent with trigger `'drag_and_drop'`.
 *
 * For the file picker button, an empty paths array with trigger `'file_picker'`
 * is sent; the Main process IPC handler shows a native file dialog.
 */
export function ImportDialog(): ReactElement {
  const [isDragging, setIsDragging] = useState(false);

  /**
   * Counter tracking nested dragenter/dragleave events.
   * Incremented on dragenter, decremented on dragleave.
   * The overlay is hidden when the counter returns to 0.
   */
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent): void => {
      e.preventDefault();
      dragCounterRef.current += 1;
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true);
      }
    };

    const handleDragLeave = (e: DragEvent): void => {
      e.preventDefault();
      dragCounterRef.current -= 1;
      if (dragCounterRef.current === 0) {
        setIsDragging(false);
      }
    };

    const handleDragOver = (e: DragEvent): void => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleDrop = (e: DragEvent): void => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);

      if (!e.dataTransfer?.files.length) return;

      const paths = extractSupportedPaths(e.dataTransfer.files);
      if (paths.length > 0) {
        void window.datspace.ingestion.importFiles(paths, 'drag_and_drop').catch((err: unknown) => {
          console.error('[ImportDialog] Drag-and-drop import failed:', err);
        });
      }
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);

  const handleFilePickerClick = useCallback((): void => {
    // Empty paths signals the Main process IPC handler to show a native file dialog
    void window.datspace.ingestion.importFiles([], 'file_picker').catch((err: unknown) => {
      console.error('[ImportDialog] File picker import failed:', err);
    });
  }, []);

  return (
    <>
      <button
        type="button"
        style={styles.importButton}
        onClick={handleFilePickerClick}
        title="Import files from disk"
      >
        + Import
      </button>
      {isDragging && (
        <div style={styles.overlay} role="dialog" aria-label="Drop files to import">
          <div style={styles.overlayContent}>
            <div style={styles.overlayIcon}>Drop files to import</div>
            <div style={styles.overlayFormats}>
              CSV, TSV, Parquet, JSON, JSONL, XLSX, XLS, Arrow IPC
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const styles = {
  importButton: {
    padding: '4px 12px',
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid #3b82f6',
    borderRadius: 6,
    backgroundColor: '#3b82f6',
    color: '#ffffff',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    lineHeight: '20px',
  },
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    backdropFilter: 'blur(2px)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none' as const,
  },
  overlayContent: {
    padding: '48px 64px',
    borderRadius: 16,
    border: '3px dashed #3b82f6',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    textAlign: 'center' as const,
    pointerEvents: 'none' as const,
  },
  overlayIcon: {
    fontSize: 24,
    fontWeight: 700,
    color: '#1e40af',
    marginBottom: 12,
  },
  overlayFormats: {
    fontSize: 14,
    color: '#6b7280',
    letterSpacing: '0.02em',
  },
} satisfies Record<string, React.CSSProperties>;
