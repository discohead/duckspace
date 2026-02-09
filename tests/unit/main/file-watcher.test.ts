import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing FileWatcher
// ---------------------------------------------------------------------------

/** Stored chokidar event handlers keyed by event name. */
const watcherHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

const mockWatcher = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!watcherHandlers[event]) {
      watcherHandlers[event] = [];
    }
    watcherHandlers[event].push(handler);
    return mockWatcher;
  }),
  close: vi.fn(() => Promise.resolve()),
};

vi.mock('chokidar', () => ({
  watch: vi.fn(() => mockWatcher),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(() => Promise.resolve({ isDirectory: () => true })),
  access: vi.fn(() => Promise.resolve()),
  constants: { R_OK: 4 },
}));

// Prevent dynamic import of ingestion-router from running actual code
vi.mock('@main/ingestion/ingestion-router', () => ({
  importFiles: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { stat } from 'node:fs/promises';
import { FileWatcher } from '@main/ingestion/file-watcher';
import type { WatchDirectory } from '@shared/types';
import { watch } from 'chokidar';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const makeWatchDir = (overrides: Partial<WatchDirectory> = {}): WatchDirectory => ({
  id: crypto.randomUUID(),
  path: '/tmp/test-dir',
  displayName: 'test-dir',
  isActive: true,
  recursive: true,
  fileTypeFilter: ['csv', 'json'],
  excludePatterns: [],
  autoReingest: false,
  stabilityThresholdMs: 2000,
  sourceCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileWatcher', () => {
  let watcher: FileWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear stored handlers
    for (const key of Object.keys(watcherHandlers)) {
      delete watcherHandlers[key];
    }
    watcher = new FileWatcher();
  });

  // -------------------------------------------------------------------------
  // restoreDirectories
  // -------------------------------------------------------------------------
  describe('restoreDirectories', () => {
    it('returns count of successfully restored directories', async () => {
      const dir1 = makeWatchDir({ id: 'dir-1', path: '/tmp/a' });
      const dir2 = makeWatchDir({ id: 'dir-2', path: '/tmp/b' });
      const dir3 = makeWatchDir({ id: 'dir-3', path: '/tmp/c' });

      const count = await watcher.restoreDirectories([dir1, dir2, dir3]);

      expect(count).toBe(3);
      expect(watcher.getActiveWatchers()).toHaveLength(3);
    });

    it('skips directories already being watched (by id)', async () => {
      const dir = makeWatchDir({ id: 'already-watched', path: '/tmp/already' });

      // Add it first
      await watcher.addDirectory(dir);
      expect(watcher.getActiveWatchers()).toHaveLength(1);

      // restoreDirectories should skip it
      const count = await watcher.restoreDirectories([dir]);

      expect(count).toBe(0);
      expect(watcher.getActiveWatchers()).toHaveLength(1);
    });

    it('skips directories already being watched (by path)', async () => {
      const dir1 = makeWatchDir({ id: 'id-1', path: '/tmp/same-path' });
      const dir2 = makeWatchDir({ id: 'id-2', path: '/tmp/same-path' });

      await watcher.addDirectory(dir1);

      const count = await watcher.restoreDirectories([dir2]);

      expect(count).toBe(0);
      expect(watcher.getActiveWatchers()).toHaveLength(1);
    });

    it('handles validation errors gracefully without throwing', async () => {
      const dir = makeWatchDir({ path: '/tmp/missing-dir' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Make stat throw to simulate missing directory
      (stat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ENOENT'));

      const count = await watcher.restoreDirectories([dir]);

      expect(count).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[FileWatcher] Skipping restoration'),
        expect.any(String),
      );

      warnSpy.mockRestore();
    });

    it('passes ignoreInitial: true to chokidar for restored directories', async () => {
      const dir = makeWatchDir({ id: 'restore-init', path: '/tmp/restore-init' });

      const count = await watcher.restoreDirectories([dir]);

      expect(count).toBe(1);
      // restoreDirectories should set ignoreInitial: true to prevent re-importing
      // files that were already ingested in the previous session
      expect(watch).toHaveBeenCalledWith(
        '/tmp/restore-init',
        expect.objectContaining({
          ignoreInitial: true,
        }),
      );
    });

    it('continues restoring remaining directories after one fails', async () => {
      const dir1 = makeWatchDir({ id: 'fail', path: '/tmp/fail' });
      const dir2 = makeWatchDir({ id: 'ok', path: '/tmp/ok' });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // First dir fails validation, second succeeds
      (stat as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce({ isDirectory: () => true });

      const count = await watcher.restoreDirectories([dir1, dir2]);

      expect(count).toBe(1);
      expect(watcher.getActiveWatchers()).toContain('ok');
      expect(watcher.getActiveWatchers()).not.toContain('fail');

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // emitWatchFileEvent — mainWindow unavailable
  // -------------------------------------------------------------------------
  describe('emitWatchFileEvent (mainWindow unavailable)', () => {
    it('logs warning when mainWindow is undefined', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const dir = makeWatchDir({ path: '/tmp/watch-test' });
      await watcher.addDirectory(dir);

      // Trigger the 'add' handler via chokidar mock
      const addHandlers = watcherHandlers['add'];
      expect(addHandlers).toBeDefined();
      expect(addHandlers!.length).toBeGreaterThan(0);
      addHandlers![0]!('/tmp/watch-test/file.csv');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('mainWindow unavailable'),
        // The log message includes the file path and event type
      );

      warnSpy.mockRestore();
    });
  });

  describe('emitSourceUpdated (mainWindow unavailable)', () => {
    it('logs warning when mainWindow is undefined on change event', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const dir = makeWatchDir({ path: '/tmp/change-test', autoReingest: false });
      await watcher.addDirectory(dir);

      // Trigger the 'change' handler — with autoReingest=false, this calls emitSourceUpdated
      const changeHandlers = watcherHandlers['change'];
      expect(changeHandlers).toBeDefined();
      expect(changeHandlers!.length).toBeGreaterThan(0);
      changeHandlers![0]!('/tmp/change-test/file.csv');

      // Should warn for both the watch file event and the source updated push
      const warnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('mainWindow unavailable'),
      );
      expect(warnings.length).toBeGreaterThanOrEqual(1);

      warnSpy.mockRestore();
    });

    it('logs warning when mainWindow is undefined on unlink event', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const dir = makeWatchDir({ path: '/tmp/unlink-test' });
      await watcher.addDirectory(dir);

      // Trigger the 'unlink' handler
      const unlinkHandlers = watcherHandlers['unlink'];
      expect(unlinkHandlers).toBeDefined();
      expect(unlinkHandlers!.length).toBeGreaterThan(0);
      unlinkHandlers![0]!('/tmp/unlink-test/file.csv');

      const warnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('mainWindow unavailable'),
      );
      expect(warnings.length).toBeGreaterThanOrEqual(1);

      warnSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // emitWatchFileEvent / emitSourceUpdated — mainWindow available
  // -------------------------------------------------------------------------
  describe('push events (mainWindow available)', () => {
    it('sends watch file event to renderer when mainWindow is available', async () => {
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend },
      } as unknown as Electron.BrowserWindow;
      watcher.setMainWindow(mockWindow);

      const dir = makeWatchDir({ path: '/tmp/send-test' });
      await watcher.addDirectory(dir);

      const addHandlers = watcherHandlers['add'];
      addHandlers![0]!('/tmp/send-test/file.csv');

      expect(mockSend).toHaveBeenCalledWith(
        'watch:fileEvent',
        expect.objectContaining({
          type: 'watch:fileEvent',
          eventType: 'add',
          filePath: '/tmp/send-test/file.csv',
          format: 'csv',
        }),
      );
    });

    it('sends source updated event for unlink when mainWindow is available', async () => {
      const mockSend = vi.fn();
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: mockSend },
      } as unknown as Electron.BrowserWindow;
      watcher.setMainWindow(mockWindow);

      const dir = makeWatchDir({ path: '/tmp/unlink-send-test' });
      await watcher.addDirectory(dir);

      const unlinkHandlers = watcherHandlers['unlink'];
      unlinkHandlers![0]!('/tmp/unlink-send-test/data.json');

      // Should send both the watch file event and the source updated event
      expect(mockSend).toHaveBeenCalledWith(
        'catalog:sourceUpdated',
        expect.objectContaining({
          filePath: '/tmp/unlink-send-test/data.json',
          status: 'removed',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // addDirectory guards
  // -------------------------------------------------------------------------
  describe('addDirectory', () => {
    it('throws when directory is already being watched by id', async () => {
      const dir = makeWatchDir({ id: 'dup-id' });
      await watcher.addDirectory(dir);

      await expect(watcher.addDirectory(dir)).rejects.toThrow('already being watched');
    });

    it('throws when directory path is already being watched under different id', async () => {
      const dir1 = makeWatchDir({ id: 'id-a', path: '/tmp/dup-path' });
      const dir2 = makeWatchDir({ id: 'id-b', path: '/tmp/dup-path' });
      await watcher.addDirectory(dir1);

      await expect(watcher.addDirectory(dir2)).rejects.toThrow('already being watched');
    });
  });

  // -------------------------------------------------------------------------
  // chokidar options
  // -------------------------------------------------------------------------
  describe('chokidar options', () => {
    it('passes usePolling and interval to chokidar watch', async () => {
      const dir = makeWatchDir({ path: '/tmp/poll-test' });
      await watcher.addDirectory(dir);

      expect(watch).toHaveBeenCalledWith(
        '/tmp/poll-test',
        expect.objectContaining({
          usePolling: true,
          interval: 1000,
          persistent: true,
          ignoreInitial: false,
          awaitWriteFinish: expect.objectContaining({
            stabilityThreshold: 2000,
            pollInterval: 200,
          }),
        }),
      );
    });

    it('sets depth: 0 for non-recursive directories', async () => {
      const dir = makeWatchDir({ path: '/tmp/shallow-test', recursive: false });
      await watcher.addDirectory(dir);

      expect(watch).toHaveBeenCalledWith(
        '/tmp/shallow-test',
        expect.objectContaining({
          usePolling: true,
          interval: 1000,
          depth: 0,
        }),
      );
    });

    it('omits depth for recursive directories', async () => {
      const dir = makeWatchDir({ path: '/tmp/deep-test', recursive: true });
      await watcher.addDirectory(dir);

      const calls = (watch as ReturnType<typeof vi.fn>).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toBeDefined();
      const options = lastCall![1] as Record<string, unknown>;
      expect(options).not.toHaveProperty('depth');
    });
  });

  // -------------------------------------------------------------------------
  // closeAll
  // -------------------------------------------------------------------------
  describe('closeAll', () => {
    it('closes all watchers and clears the map', async () => {
      await watcher.addDirectory(makeWatchDir({ id: 'w1', path: '/tmp/w1' }));
      await watcher.addDirectory(makeWatchDir({ id: 'w2', path: '/tmp/w2' }));
      expect(watcher.getActiveWatchers()).toHaveLength(2);

      await watcher.closeAll();

      expect(watcher.getActiveWatchers()).toHaveLength(0);
      expect(mockWatcher.close).toHaveBeenCalled();
    });
  });
});
