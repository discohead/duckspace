/**
 * File watcher service for monitoring directories and triggering data ingestion.
 * Uses chokidar v4 to watch for file changes and dispatches ingestion events.
 */

import type { Stats } from 'node:fs';
import { access, constants as fsConstants, stat } from 'node:fs/promises';
import path from 'node:path';
import { PUSH_EVENTS } from '@shared/constants';
import {
  alreadyWatchingError,
  directoryNotFoundError,
  directoryPermissionDeniedError,
  notADirectoryError,
} from '@shared/errors';
import type {
  CatalogSourceUpdatedEvent,
  DataSourceFormat,
  WatchDirectory,
  WatchFileEvent,
} from '@shared/types';
import { type FSWatcher, watch } from 'chokidar';
import type { BrowserWindow } from 'electron';
import { getDataSourceIdByFilePath } from './ingestion-router';

// ---------------------------------------------------------------------------
// Extension → Format mapping (synchronous, no I/O)
// ---------------------------------------------------------------------------

/**
 * Map from file extension to the canonical {@link DataSourceFormat}.
 *
 * Multiple extensions may map to the same format (e.g. `arrow`, `ipc`,
 * `feather` all resolve to `'arrow_ipc'`; `ndjson` resolves to `'jsonl'`;
 * `xls` resolves to `'xlsx'`).
 */
const EXTENSION_TO_FORMAT: Readonly<Record<string, DataSourceFormat>> = {
  csv: 'csv',
  tsv: 'tsv',
  parquet: 'parquet',
  json: 'json',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  xlsx: 'xlsx',
  xls: 'xlsx',
  arrow: 'arrow_ipc',
  ipc: 'arrow_ipc',
  feather: 'arrow_ipc',
};

/**
 * Derive the {@link DataSourceFormat} from a file extension (without the dot).
 *
 * @param ext - Lowercase file extension, e.g. `"csv"`.
 * @returns The corresponding format, or `undefined` if the extension is not supported.
 */
function getFormatFromExtension(ext: string): DataSourceFormat | undefined {
  return EXTENSION_TO_FORMAT[ext.toLowerCase()];
}

/**
 * Build a set of accepted file extensions from a list of {@link DataSourceFormat}
 * values. Reverse-maps format names back to all matching extensions.
 */
function formatFilterToExtensions(formats: readonly DataSourceFormat[]): ReadonlySet<string> {
  const exts = new Set<string>();
  const formatSet = new Set<DataSourceFormat>(formats);
  for (const [ext, format] of Object.entries(EXTENSION_TO_FORMAT)) {
    if (formatSet.has(format)) {
      exts.add(ext);
    }
  }
  return exts;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Tracks a single watched directory and its chokidar instance. */
interface WatchEntry {
  readonly config: WatchDirectory;
  readonly watcher: FSWatcher;
}

// ---------------------------------------------------------------------------
// FileWatcher service
// ---------------------------------------------------------------------------

/**
 * Manages chokidar watchers for one or more directories, dispatching ingestion
 * requests and push events to the renderer when files are added, changed, or
 * removed.
 *
 * Lifecycle:
 * 1. Instantiate with `new FileWatcher()`.
 * 2. Call {@link setMainWindow} once the BrowserWindow is available.
 * 3. Call {@link addDirectory} for each directory the user wants to watch.
 * 4. Call {@link closeAll} during the shutdown sequence.
 */
export class FileWatcher {
  /** Active watchers keyed by `WatchDirectory.id`. */
  private readonly watchers = new Map<string, WatchEntry>();

  /** Renderer window used for push events. May be set after construction. */
  private mainWindow: BrowserWindow | undefined;

  // -----------------------------------------------------------------------
  // Dependency setters
  // -----------------------------------------------------------------------

  /**
   * Set (or replace) the main BrowserWindow reference used for push events.
   *
   * @param win - The active BrowserWindow.
   */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Begin watching a directory for file changes.
   *
   * @param config - Watch directory configuration including path, filters, and
   *   ingestion behaviour.
   * @param options - Additional options. When `ignoreInitial` is `true`,
   *   chokidar skips `add` events for existing files on the first scan,
   *   preventing duplicate imports of already-ingested files.
   * @throws `directoryNotFoundError` if the path does not exist.
   * @throws `notADirectoryError` if the path is not a directory.
   * @throws `directoryPermissionDeniedError` if the path is not readable.
   * @throws `alreadyWatchingError` if the directory is already being watched.
   */
  async addDirectory(config: WatchDirectory, options?: { ignoreInitial?: boolean }): Promise<void> {
    // Guard: already watching this id
    if (this.watchers.has(config.id)) {
      throw alreadyWatchingError(config.path);
    }

    // Guard: already watching this path (different id)
    if (this.isWatching(config.path)) {
      throw alreadyWatchingError(config.path);
    }

    // Validate the target directory
    await this.validateDirectory(config.path);

    // Build the set of accepted lowercase extensions from the format filter
    const acceptedExtensions = formatFilterToExtensions(config.fileTypeFilter);

    // Build the chokidar `ignored` callback (MatchFunction signature)
    const ignored = (filePath: string, stats?: Stats): boolean => {
      // Never ignore directories — chokidar needs to traverse them
      if (stats?.isDirectory()) {
        return false;
      }

      // Check exclude patterns
      if (config.excludePatterns.length > 0) {
        const basename = path.basename(filePath);
        for (const pattern of config.excludePatterns) {
          if (basename === pattern || filePath.includes(pattern)) {
            return true;
          }
        }
      }

      // For files, check extension against the accepted filter.
      // Allow extensionless paths through — they may be directories (chokidar
      // calls `ignored` without stats on the first pass, so the stats?.isDirectory()
      // guard above won't catch them). The handleAdd guard skips unknown formats.
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (ext === '') {
        return false;
      }
      return !acceptedExtensions.has(ext);
    };

    // Build chokidar options — `depth` must be omitted entirely when recursive
    // to satisfy `exactOptionalPropertyTypes` (undefined !== number).
    const shouldIgnoreInitial = options?.ignoreInitial === true;
    const baseOptions = {
      persistent: true as const,
      ignoreInitial: shouldIgnoreInitial,
      awaitWriteFinish: {
        stabilityThreshold: config.stabilityThresholdMs,
        pollInterval: 200,
      },
      ignored,
      // Chokidar v4's native fs.watch() does not emit events in Electron 33
      // (FSEvents/kqueue issue with Chromium's event loop). Stat-based polling
      // at 1s intervals has negligible CPU overhead for a desktop app.
      usePolling: true as const,
      interval: 1000,
    };

    const watchOptions = config.recursive ? baseOptions : { ...baseOptions, depth: 0 };

    // Create the chokidar watcher
    const watcher = watch(config.path, watchOptions);

    // Wire up event handlers
    watcher.on('add', (filePath: string) => {
      this.handleAdd(config, filePath);
    });

    watcher.on('change', (filePath: string) => {
      this.handleChange(config, filePath);
    });

    watcher.on('unlink', (filePath: string) => {
      this.handleUnlink(config, filePath);
    });

    watcher.on('error', (err: unknown) => {
      console.error(`[FileWatcher] Error in watcher for "${config.path}" (id=${config.id}):`, err);
    });

    watcher.on('ready', () => {
      console.log(`[FileWatcher] Watcher ready for "${config.path}" (id=${config.id})`);
    });

    this.watchers.set(config.id, { config, watcher });
    console.log(
      `[FileWatcher] Watching "${config.path}" (id=${config.id}, formats=${config.fileTypeFilter.join(',')}, recursive=${String(config.recursive)})`,
    );
  }

  /**
   * Stop watching a directory and release its watcher resources.
   *
   * @param watchDirectoryId - The `WatchDirectory.id` to stop.
   */
  async removeDirectory(watchDirectoryId: string): Promise<void> {
    const entry = this.watchers.get(watchDirectoryId);
    if (entry === undefined) {
      return;
    }
    await entry.watcher.close();
    this.watchers.delete(watchDirectoryId);
  }

  /**
   * Stop all active watchers. Intended for the shutdown sequence.
   */
  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [id, entry] of this.watchers) {
      closePromises.push(
        entry.watcher.close().then(() => {
          this.watchers.delete(id);
        }),
      );
    }
    const results = await Promise.allSettled(closePromises);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[FileWatcher] Failed to close a watcher:', result.reason);
      }
    }
  }

  /**
   * Restore previously configured watch directories (e.g. on app restart).
   * Skips directories that are already being watched and logs errors
   * for directories that fail validation (e.g. deleted since last session).
   *
   * @param directories - Array of watch directory configs to restore.
   * @returns Count of successfully restored directories.
   */
  async restoreDirectories(directories: readonly WatchDirectory[]): Promise<number> {
    let restored = 0;
    for (const dir of directories) {
      if (this.watchers.has(dir.id) || this.isWatching(dir.path)) {
        continue;
      }
      try {
        // ignoreInitial: true — files were already ingested in a previous session;
        // re-emitting `add` events would cause duplicate imports.
        await this.addDirectory(dir, { ignoreInitial: true });
        restored++;
      } catch (err: unknown) {
        console.warn(
          `[FileWatcher] Skipping restoration of "${dir.path}" (id=${dir.id}):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.log(
      `[FileWatcher] Restored ${String(restored)}/${String(directories.length)} watch directories`,
    );
    return restored;
  }

  /**
   * Return the IDs of all actively watched directories.
   *
   * @returns Array of `WatchDirectory.id` strings.
   */
  getActiveWatchers(): string[] {
    return [...this.watchers.keys()];
  }

  /**
   * Check whether the given directory path is already being watched.
   *
   * @param dirPath - Absolute directory path.
   * @returns `true` if a watcher exists for this path.
   */
  isWatching(dirPath: string): boolean {
    const normalised = path.resolve(dirPath);
    for (const entry of this.watchers.values()) {
      if (path.resolve(entry.config.path) === normalised) {
        return true;
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Event handlers (private)
  // -----------------------------------------------------------------------

  /**
   * Handle a new file appearing in a watched directory.
   */
  private handleAdd(config: WatchDirectory, filePath: string): void {
    try {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const format = getFormatFromExtension(ext);

      // Guard: skip if extension did not resolve to a known format
      if (format === undefined) {
        return;
      }

      // Emit push event to the renderer
      this.emitWatchFileEvent({
        type: 'watch:fileEvent',
        watchDirectoryId: config.id,
        eventType: 'add',
        filePath,
        format,
      });

      // Trigger ingestion (lazy import to avoid circular dependencies)
      void import('./ingestion-router')
        .then((mod) => {
          void mod.importFiles([filePath], 'watch_directory');
        })
        .catch((err: unknown) => {
          console.error(`[FileWatcher] Failed to import file "${filePath}":`, err);
        });
    } catch (err: unknown) {
      console.error(`[FileWatcher] Error handling 'add' for "${filePath}":`, err);
    }
  }

  /**
   * Handle a file being modified in a watched directory.
   */
  private handleChange(config: WatchDirectory, filePath: string): void {
    try {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const format = getFormatFromExtension(ext);

      // Guard: skip if extension did not resolve to a known format
      if (format === undefined) {
        return;
      }

      this.emitWatchFileEvent({
        type: 'watch:fileEvent',
        watchDirectoryId: config.id,
        eventType: 'change',
        filePath,
        format,
      });

      if (config.autoReingest) {
        // Re-ingest the changed file
        void import('./ingestion-router')
          .then((mod) => {
            void mod.importFiles([filePath], 'watch_directory');
          })
          .catch((err: unknown) => {
            console.error(`[FileWatcher] Failed to re-ingest file "${filePath}":`, err);
          });
      } else {
        // Notify renderer the source is stale
        this.emitSourceUpdated(filePath, 'stale');
      }
    } catch (err: unknown) {
      console.error(`[FileWatcher] Error handling 'change' for "${filePath}":`, err);
    }
  }

  /**
   * Handle a file being removed from a watched directory.
   */
  private handleUnlink(config: WatchDirectory, filePath: string): void {
    try {
      this.emitWatchFileEvent({
        type: 'watch:fileEvent',
        watchDirectoryId: config.id,
        eventType: 'unlink',
        filePath,
        format: undefined,
      });

      // Notify renderer the source has been removed
      this.emitSourceUpdated(filePath, 'removed');
    } catch (err: unknown) {
      console.error(`[FileWatcher] Error handling 'unlink' for "${filePath}":`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Push event helpers (private)
  // -----------------------------------------------------------------------

  /**
   * Send a {@link WatchFileEvent} to the renderer via the main window.
   */
  private emitWatchFileEvent(event: WatchFileEvent): void {
    if (this.mainWindow === undefined || this.mainWindow.isDestroyed()) {
      console.warn(
        `[FileWatcher] mainWindow unavailable, dropping ${event.eventType} event for "${event.filePath}"`,
      );
      return;
    }
    this.mainWindow.webContents.send(PUSH_EVENTS.WATCH_FILE_EVENT, event);
  }

  /**
   * Notify the renderer that a data source's status has changed.
   * Looks up the `dataSourceId` from the ingestion router's file-path map.
   * If no data source is registered for the path (e.g. file was never ingested),
   * the event is dropped with a warning.
   */
  private emitSourceUpdated(filePath: string, status: 'stale' | 'removed'): void {
    if (this.mainWindow === undefined || this.mainWindow.isDestroyed()) {
      console.warn(
        `[FileWatcher] mainWindow unavailable, dropping sourceUpdated (${status}) for "${filePath}"`,
      );
      return;
    }

    const dataSourceId = getDataSourceIdByFilePath(filePath);
    if (dataSourceId === undefined) {
      console.warn(
        `[FileWatcher] No dataSourceId found for "${filePath}", dropping sourceUpdated (${status})`,
      );
      return;
    }

    const event: CatalogSourceUpdatedEvent = {
      type: 'catalog:sourceUpdated',
      dataSourceId,
      status,
    };
    this.mainWindow.webContents.send(PUSH_EVENTS.CATALOG_SOURCE_UPDATED, event);
  }

  // -----------------------------------------------------------------------
  // Validation helpers (private)
  // -----------------------------------------------------------------------

  /**
   * Validate that a directory path exists, is a directory, and is readable.
   */
  private async validateDirectory(dirPath: string): Promise<void> {
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(dirPath);
    } catch {
      throw directoryNotFoundError(dirPath);
    }

    if (!stats.isDirectory()) {
      throw notADirectoryError(dirPath);
    }

    try {
      await access(dirPath, fsConstants.R_OK);
    } catch {
      throw directoryPermissionDeniedError(dirPath);
    }
  }
}
