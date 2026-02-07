import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'module';

// ---------------------------------------------------------------------------
// Hoisted mock variables -- available when vi.mock factories are hoisted
// ---------------------------------------------------------------------------

const {
  mockApp,
  appEventHandlers,
  mockStartupSequence,
  mockShutdownSequence,
  mockGetMainWindow,
  state,
} = vi.hoisted(() => {
  const appEventHandlers: Record<string, (...args: any[]) => any> = {};
  const state = {
    whenReadyResolver: null as (() => void) | null,
    requestSingleInstanceLockReturn: true,
  };

  const mockApp = {
    requestSingleInstanceLock: vi.fn(() => state.requestSingleInstanceLockReturn),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          state.whenReadyResolver = resolve;
        }),
    ),
    on: vi.fn((event: string, handler: (...args: any[]) => any) => {
      appEventHandlers[event] = handler;
    }),
  };

  const mockStartupSequence = vi.fn().mockResolvedValue(undefined);
  const mockShutdownSequence = vi.fn().mockResolvedValue(undefined);
  const mockGetMainWindow = vi.fn(() => null);

  return {
    mockApp,
    appEventHandlers,
    mockStartupSequence,
    mockShutdownSequence,
    mockGetMainWindow,
    state,
  };
});

// ---------------------------------------------------------------------------
// Static vi.mock declarations (hoisted above imports)
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: mockApp,
}));

vi.mock('@main/lifecycle', () => ({
  startupSequence: mockStartupSequence,
  shutdownSequence: mockShutdownSequence,
  getMainWindow: mockGetMainWindow,
}));

// ---------------------------------------------------------------------------
// Intercept native require('./lifecycle') from src/main/index.ts
//
// The source uses CJS require('./lifecycle') inside event handler callbacks.
// Vitest does not transform dynamic require() calls inside callbacks, so they
// go through Node's native require() which cannot find './lifecycle' (no
// compiled .js file exists at that path). We patch Module._resolveFilename
// to redirect these calls to a resolved path that vitest can intercept.
// ---------------------------------------------------------------------------

const lifecycleMock = {
  startupSequence: mockStartupSequence,
  shutdownSequence: mockShutdownSequence,
  getMainWindow: mockGetMainWindow,
};

const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any,
) {
  // Intercept require('./lifecycle') from src/main/index.ts
  if (
    request === './lifecycle' &&
    parent?.filename?.includes('src/main/index')
  ) {
    // Return a sentinel that we'll intercept in _cache
    return '__mocked_lifecycle__';
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Inject our mock into Node's require cache under the sentinel key
require.cache['__mocked_lifecycle__'] = {
  id: '__mocked_lifecycle__',
  filename: '__mocked_lifecycle__',
  loaded: true,
  exports: lifecycleMock,
  parent: null,
  children: [],
  paths: [],
  path: '',
  isPreloading: false,
  require: require,
} as any;

// ---------------------------------------------------------------------------
// Import the module under test -- triggers the side effects
// ---------------------------------------------------------------------------

import '@main/index';

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  (Module as any)._resolveFilename = originalResolveFilename;
  delete require.cache['__mocked_lifecycle__'];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('main/index.ts (entry point side effects)', () => {
  // -----------------------------------------------------------------------
  // Single-instance lock
  // -----------------------------------------------------------------------

  describe('single-instance lock', () => {
    it('registers event handlers when lock is obtained', () => {
      expect(mockApp.requestSingleInstanceLock).toHaveBeenCalled();
      const registeredEvents = mockApp.on.mock.calls.map(
        (call: [string, unknown]) => call[0],
      );
      expect(registeredEvents).toContain('second-instance');
      expect(registeredEvents).toContain('before-quit');
      expect(registeredEvents).toContain('window-all-closed');
      expect(registeredEvents).toContain('activate');
    });

    it('calls app.quit() when lock is not obtained', async () => {
      vi.resetModules();
      state.requestSingleInstanceLockReturn = false;

      vi.doMock('electron', () => ({ app: mockApp }));
      vi.doMock('@main/lifecycle', () => lifecycleMock);

      mockApp.quit.mockClear();
      mockApp.on.mockClear();

      await import('@main/index');

      expect(mockApp.quit).toHaveBeenCalled();
      expect(mockApp.on).not.toHaveBeenCalled();

      state.requestSingleInstanceLockReturn = true;
    });
  });

  // -----------------------------------------------------------------------
  // whenReady -> startupSequence
  // -----------------------------------------------------------------------

  describe('whenReady', () => {
    it('triggers startupSequence when app is ready', async () => {
      expect(mockApp.whenReady).toHaveBeenCalled();
      expect(state.whenReadyResolver).not.toBeNull();

      state.whenReadyResolver!();

      await vi.waitFor(() => {
        expect(mockStartupSequence).toHaveBeenCalled();
      });
    });
  });

  // -----------------------------------------------------------------------
  // before-quit
  // -----------------------------------------------------------------------

  describe('before-quit', () => {
    // The before-quit handler has module-level isShuttingDown state that
    // persists across calls. Each test that invokes the handler needs a
    // fresh module import to reset this flag.

    async function freshImportWithHandlers(): Promise<void> {
      vi.resetModules();
      state.requestSingleInstanceLockReturn = true;
      for (const key of Object.keys(appEventHandlers)) {
        delete appEventHandlers[key];
      }
      mockApp.on.mockClear();

      vi.doMock('electron', () => ({ app: mockApp }));
      vi.doMock('@main/lifecycle', () => lifecycleMock);
      await import('@main/index');
    }

    it('calls preventDefault and shutdownSequence on before-quit', async () => {
      await freshImportWithHandlers();
      mockShutdownSequence.mockClear();

      expect(appEventHandlers['before-quit']).toBeDefined();

      const mockEvent = { preventDefault: vi.fn() };
      appEventHandlers['before-quit'](mockEvent);

      expect(mockEvent.preventDefault).toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(mockShutdownSequence).toHaveBeenCalledTimes(1);
      });
    });

    it('only runs shutdownSequence once (isShuttingDown guard)', async () => {
      await freshImportWithHandlers();
      mockShutdownSequence.mockClear();

      const event1 = { preventDefault: vi.fn() };
      const event2 = { preventDefault: vi.fn() };

      // First call triggers shutdown
      appEventHandlers['before-quit'](event1);
      expect(event1.preventDefault).toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(mockShutdownSequence).toHaveBeenCalledTimes(1);
      });

      // Second call -- isShuttingDown is now true, so handler is a no-op
      appEventHandlers['before-quit'](event2);

      expect(mockShutdownSequence).toHaveBeenCalledTimes(1);
      expect(event2.preventDefault).not.toHaveBeenCalled();
    });

    it('calls app.exit(1) if shutdownSequence throws', async () => {
      await freshImportWithHandlers();
      mockApp.exit.mockClear();
      mockShutdownSequence.mockRejectedValueOnce(new Error('shutdown error'));

      const mockEvent = { preventDefault: vi.fn() };
      appEventHandlers['before-quit'](mockEvent);

      await vi.waitFor(() => {
        expect(mockApp.exit).toHaveBeenCalledWith(1);
      });
    });
  });

  // -----------------------------------------------------------------------
  // window-all-closed
  // -----------------------------------------------------------------------

  describe('window-all-closed', () => {
    it('calls app.quit when all windows are closed', () => {
      mockApp.quit.mockClear();

      expect(appEventHandlers['window-all-closed']).toBeDefined();
      appEventHandlers['window-all-closed']();

      expect(mockApp.quit).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // activate (macOS dock click)
  // -----------------------------------------------------------------------

  describe('activate', () => {
    it('handler is registered', () => {
      expect(appEventHandlers['activate']).toBeDefined();
    });

    it('calls startupSequence when no main window exists', () => {
      mockGetMainWindow.mockReturnValue(null);
      mockStartupSequence.mockClear();

      appEventHandlers['activate']();

      expect(mockStartupSequence).toHaveBeenCalled();
    });

    it('does not call startupSequence when main window exists', () => {
      const mockWin = { isMinimized: vi.fn(), focus: vi.fn() };
      mockGetMainWindow.mockReturnValue(mockWin as any);
      mockStartupSequence.mockClear();

      appEventHandlers['activate']();

      expect(mockStartupSequence).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // second-instance
  // -----------------------------------------------------------------------

  describe('second-instance', () => {
    it('handler is registered', () => {
      expect(appEventHandlers['second-instance']).toBeDefined();
    });

    it('focuses existing window on second-instance event', () => {
      const mockWin = {
        isMinimized: vi.fn(() => false),
        focus: vi.fn(),
        restore: vi.fn(),
      };
      mockGetMainWindow.mockReturnValue(mockWin as any);

      appEventHandlers['second-instance']();

      expect(mockWin.focus).toHaveBeenCalled();
    });

    it('restores minimized window on second-instance event', () => {
      const mockWin = {
        isMinimized: vi.fn(() => true),
        focus: vi.fn(),
        restore: vi.fn(),
      };
      mockGetMainWindow.mockReturnValue(mockWin as any);

      appEventHandlers['second-instance']();

      expect(mockWin.restore).toHaveBeenCalled();
      expect(mockWin.focus).toHaveBeenCalled();
    });

    it('handles no window gracefully on second-instance', () => {
      mockGetMainWindow.mockReturnValue(null);

      // Should not throw
      expect(() => appEventHandlers['second-instance']()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Event registration
  // -----------------------------------------------------------------------

  describe('event registration', () => {
    it('registers all expected app event handlers', () => {
      const registeredEvents = mockApp.on.mock.calls.map(
        (call: [string, unknown]) => call[0],
      );
      expect(registeredEvents).toContain('second-instance');
      expect(registeredEvents).toContain('before-quit');
      expect(registeredEvents).toContain('window-all-closed');
      expect(registeredEvents).toContain('activate');
    });
  });
});
