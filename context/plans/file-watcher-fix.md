# File Watcher Bug: Debug & Fix Plan

**Date**: 2026-02-08
**Status**: Fixed — two bugs: (1) `ignored` callback rejected directories when `stats` was undefined, (2) added `usePolling: true` as safety net for Electron's `fs.watch()` issue
**Branch**: `002-local-data-ingestion`
**QA Report**: `qa-reports/qa-report-2026-02-08-post-fix.md` (QA-POST-1)

## Problem Statement

File watcher events never propagate to the renderer. Watch directories show "active" status and "0 sources" indefinitely, even when matching files exist or are created in the watched directory. Auto-ingestion never triggers.

## Root Cause Analysis (Completed)

### What we know

End-to-end diagnostic logging was added across the full event chain:

```
chokidar 'add' event
  -> FileWatcher.handleAdd()      [FileWatcher] add: "..."
    -> emitWatchFileEvent()        [FileWatcher] Sending add event...
      -> webContents.send()        (IPC channel)
        -> preload ipcRenderer.on  [Preload:watch] Received ...
          -> React useEffect       [App:watch] Received ...
            -> Dexie update        [App:watch] Updating sourceCount...
```

### Where the chain breaks

| Stage | Log | Status |
|-------|-----|--------|
| Watcher created | `[FileWatcher] Watching "..."` | Fires |
| Watcher ready | `[FileWatcher] Watcher ready` | Fires |
| **File detected** | **`[FileWatcher] add: "..."`** | **NEVER fires** |
| Event sent to renderer | `[FileWatcher] Sending...` | N/A (upstream broken) |

### Verified working

1. **IPC channel**: Manual probe via `electron_evaluate` → `webContents.send('watch:fileEvent', ...)` → received in preload and React. Full chain works.
2. **Watch config**: Dexie stores correct config — all formats enabled, no exclude patterns, recursive, 2000ms stability threshold.
3. **FileWatcher instance**: `listDirectories()` returns active watcher IDs. Watchers are registered and "ready".
4. **Chokidar standalone**: Works perfectly in standalone Node.js — detects existing files (via `ignoreInitial: false`) and new files.

### Root cause: chokidar v4's `fs.watch()` fails in Electron 33

- **Chokidar v4.0.3** removed its fsevents dependency. It uses Node's built-in `fs.watch()` which delegates to the OS (FSEvents/kqueue on macOS).
- `fs.watch()` does NOT emit events when running inside Electron 33's main process (at least when launched via Playwright MCP's `_electron.launch()`).
- The watcher initializes (`ready` fires), but file system change events never arrive.
- This is **not** an issue with our code, config, IPC, or format filters. It is an environment-level incompatibility between chokidar v4's `fs.watch()` backend and Electron's Chromium event loop integration.

### Open question

**Is this Playwright-MCP-specific or does it affect all Electron launches (including `npx electron-forge start`)?**

This is the critical disambiguation that determines the fix strategy.

## Evidence

### Main process stdout (from crash dump)

```
[pid=65508][out] [FileWatcher] Watching "/tmp/datspace-diag-test" (id=d4cae913-...)
[pid=65508][out] [FileWatcher] Restored 1/1 watch directories
[pid=65508][out] [FileWatcher] Watcher ready for "/tmp/datspace-diag-test" (id=d4cae913-...)
[pid=65508][out] [FileWatcher] Watching "/tmp/datspace-chokidar-probe" (id=dcdc87bf-...)
[pid=65508][out] [FileWatcher] Watcher ready for "/tmp/datspace-chokidar-probe" (id=dcdc87bf-...)
```

Zero `[FileWatcher] add:` entries in the entire process lifetime, despite:
- Existing files in the directory (`ignoreInitial: false` should emit them)
- New files created via `printf '...' > file.csv` during the session
- 12+ seconds of wait time (stability threshold is 2000ms)

### Standalone Node.js confirmation

```
$ timeout 8 node -e "const { watch } = require('chokidar'); ..."
ADD: /tmp/datspace-diag-test/diag-test-1770590756.csv
ADD: /tmp/datspace-diag-test/intercepted-test.csv
ADD: /tmp/datspace-diag-test/live-test.csv
ADD: /tmp/datspace-diag-test/test-data.csv
READY
Created node-test.csv
ADD: /tmp/datspace-diag-test/node-test.csv
```

Works perfectly — both initial scan and real-time detection.

### ABI mismatch (potentially related)

```
fsevents.node: compiled for Node ABI 137
Electron 33: uses ABI 130
```

However, chokidar v4 does NOT use fsevents. It uses `fs.watch()` which is a Node built-in. The fsevents ABI mismatch is irrelevant to chokidar v4 (it was relevant to chokidar v3).

## Fix Strategies

### Strategy A: Determine scope first (Recommended)

Before applying any fix, determine if the bug affects `electron-forge start` or only Playwright MCP launches.

**Test procedure:**
1. Run `npx electron-forge start`
2. Add a watch directory via the UI
3. Create a file in the watched directory
4. Check the terminal output for `[FileWatcher] add:` logs
5. Check the UI for sourceCount update

**If it works under Forge:** The bug is Playwright-MCP-specific. The fix is to document this as a known QA limitation and potentially add `usePolling: true` only when a diagnostic flag is set.

**If it also fails under Forge:** The bug affects all users and needs a production fix.

### Strategy B: `usePolling: true` fallback

Add polling-based file watching as a fallback when `fs.watch()` events are not received.

```typescript
// In addDirectory():
const watchOptions = config.recursive ? baseOptions : { ...baseOptions, depth: 0 };

// Detect Electron environment and use polling
const isElectron = typeof process !== 'undefined' && process.versions?.electron;
if (isElectron) {
  watchOptions.usePolling = true;
  watchOptions.interval = 1000; // 1 second poll interval
}
```

**Pros**: Simple, guaranteed to work in all environments.
**Cons**: Higher CPU usage (polling vs native events), slower detection (up to `interval` ms delay), not needed if the bug is Playwright-MCP-specific.

### Strategy C: Downgrade to chokidar v3

Chokidar v3 bundles fsevents natively and doesn't rely on `fs.watch()`. However, it requires `electron-rebuild` to compile fsevents for Electron's ABI.

```bash
npm install chokidar@^3
npx electron-rebuild -f -w fsevents
```

**Pros**: Uses native FSEvents which historically works in Electron.
**Cons**: More dependencies (chokidar v3 has 13 deps vs v4's 1), requires electron-rebuild in the build pipeline, may have other compatibility issues.

### Strategy D: Replace chokidar with `@parcel/watcher`

Use `@parcel/watcher` directly, which is a native module specifically designed for file watching with excellent Electron compatibility.

```bash
npm install @parcel/watcher
npx electron-rebuild -f -w @parcel/watcher
```

**Pros**: High-performance native watcher, battle-tested in Electron (used by Vite internally).
**Cons**: Different API (subscription-based, not event-emitter), requires electron-rebuild, more invasive code changes.

### Strategy E: Environment-aware hybrid approach

Use `fs.watch()` (chokidar v4 default) with an automatic fallback to polling if no events are received within a timeout after the initial scan.

```typescript
// After watcher.on('ready'), set a verification timer
watcher.on('ready', () => {
  // Create a probe file, wait for the add event
  // If no event within 5 seconds, restart with usePolling: true
});
```

**Pros**: Best of both worlds — native performance when available, automatic fallback.
**Cons**: More complex implementation, startup delay for the probe.

## Recommended Approach

1. **First**: Run Strategy A to determine scope. This takes 5 minutes and determines everything.
2. **If Forge works**: Document as Playwright-MCP limitation. Optionally add `usePolling: true` behind a `DATSPACE_FILE_WATCHER_POLLING=1` env var for debugging.
3. **If Forge fails too**: Implement Strategy B (`usePolling: true` in Electron) as the immediate fix, then evaluate Strategy D (`@parcel/watcher`) for a longer-term solution.

## Files Involved

| File | Role |
|------|------|
| `src/main/ingestion/file-watcher.ts` | FileWatcher class — watcher creation, event handlers, push events |
| `src/main/lifecycle.ts` | Creates FileWatcher, sets mainWindow reference |
| `src/main/ipc-handlers.ts` | IPC handlers for add/remove/list/restore watch directories |
| `src/preload/index.ts` | Preload bridge — `onFileEvent` listener |
| `src/renderer/App.tsx` | React handler — updates Dexie sourceCount, restores directories |
| `src/renderer/components/WatchDirConfig.tsx` | UI for adding/removing watch directories |
| `src/renderer/stores/db.ts` | Dexie schema — `watch_directories` table |
| `src/shared/types.ts` | `WatchDirectory`, `WatchFileEvent` types |
| `src/shared/constants.ts` | `PUSH_EVENTS.WATCH_FILE_EVENT` channel name |
| `tests/unit/main/file-watcher.test.ts` | Unit tests for FileWatcher |
| `vite.main.config.ts` | Vite config — chokidar externalization |
| `scripts/build-e2e.mjs` | E2E build script — chokidar externalization |

## Diagnostic Logging (Already Added)

The following diagnostic logs are now in the codebase and will be present in all builds:

### Main process (`file-watcher.ts`)
- `[FileWatcher] Watching "..." (id=..., formats=..., recursive=...)`
- `[FileWatcher] Watcher ready for "..." (id=...)`
- `[FileWatcher] Restored N/M watch directories`
- `[FileWatcher] add: "..." (dir=..., format=...)`
- `[FileWatcher] change: "..." (dir=..., autoReingest=...)`
- `[FileWatcher] unlink: "..." (dir=...)`
- `[FileWatcher] Sending {eventType} event to renderer: "..."`
- `[FileWatcher] mainWindow unavailable, dropping ...` (warn — existing)

### Preload (`preload/index.ts`)
- `[Preload:watch] Received {eventType} event: "..."`

### Renderer (`App.tsx`)
- `[App:watch] Restoring N active watch directories`
- `[App:watch] Restored N/M directories`
- `[App:watch] Received {eventType} for dir=..., file="..."`
- `[App:watch] Updating sourceCount for dir=...: N -> M`
- `[App:watch] No watch directory found for id=...` (warn)
- `[App:watch] Failed to restore watch directories: ...` (warn — replaces silent catch)

## Debugging Technique: Main Process Log Forwarding

To see main process logs via Playwright MCP's `browser_console_messages`, install this monkey-patch via `electron_evaluate`:

```javascript
const { BrowserWindow } = process._linkedBinding('electron_browser_window');
const win = BrowserWindow.getAllWindows()[0];
const origLog = console.log;
const origWarn = console.warn;
const forward = (level, args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (msg.includes('[FileWatcher]')) {
    try {
      win.webContents.executeJavaScript(
        'console.log("[MAIN] " + ' + JSON.stringify(msg) + ')'
      );
    } catch(e) {}
  }
};
console.log = function(...args) { origLog.apply(console, args); forward('LOG', args); };
console.warn = function(...args) { origWarn.apply(console, args); forward('WARN', args); };
```

## Debugging Technique: `electron_evaluate` API Access

Playwright's `electron_evaluate` runs in a sandboxed eval context where `require` and `import()` are unavailable. Access Electron APIs via internal linked bindings:

```javascript
// BrowserWindow
const { BrowserWindow } = process._linkedBinding('electron_browser_window');
const win = BrowserWindow.getAllWindows()[0];

// App
const { app } = process._linkedBinding('electron_browser_app');

// WebContents
const { WebContents } = process._linkedBinding('electron_browser_web_contents');

// Bridge to renderer (IPC, Dexie, preload bridge)
win.webContents.executeJavaScript(`
  window.datspace.watch.listDirectories().then(dirs => JSON.stringify(dirs))
`);

// Access IndexedDB directly
win.webContents.executeJavaScript(`
  new Promise((resolve) => {
    const req = indexedDB.open('Datspace');
    req.onsuccess = () => {
      const tx = req.result.transaction('watch_directories', 'readonly');
      const getAll = tx.objectStore('watch_directories').getAll();
      getAll.onsuccess = () => resolve(JSON.stringify(getAll.result));
    };
  })
`);

// Send a manual IPC event to test the chain
win.webContents.send('watch:fileEvent', {
  type: 'watch:fileEvent',
  watchDirectoryId: 'test-probe',
  eventType: 'add',
  filePath: '/tmp/probe.csv',
  format: 'csv'
});
```
