import { app } from 'electron';
import { getMainWindow, shutdownSequence, startupSequence } from './lifecycle';

// T024b: Single-instance lock - prevent concurrent DuckDB file access corruption
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window when a second instance is attempted
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let isShuttingDown = false;

  void app.whenReady().then(async () => {
    try {
      await startupSequence();
    } catch (err) {
      console.error('Failed to start application:', err);
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (!isShuttingDown) {
      event.preventDefault();
      isShuttingDown = true;
      void (async () => {
        try {
          await shutdownSequence();
        } catch (err) {
          console.error('Error during shutdown:', err);
          app.exit(1);
        }
      })();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  // macOS: Re-create window when dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (!getMainWindow()) {
      startupSequence().catch(console.error);
    }
  });
}
