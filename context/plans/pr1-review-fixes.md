# TDD Implementation Plan: PR #1 Review Fixes

> **PR**: feat(001): Electron foundation with DuckDB worker architecture
> **Branch**: `001-electron-foundation` | **Additions**: 44,646 | **Files**: 131
> **Review**: 5-agent comprehensive review found 9 critical, 14 important issues + documentation concerns
> **Approach**: Strict TDD — write failing tests first, implement minimal fix, refactor
> **Estimated new tests**: ~72 across 23 issues

---

## Table of Contents

- [Dependency Graph](#dependency-graph)
- [Phase 1: Critical Fixes](#phase-1-critical-fixes-must-fix-before-merge)
  - [Milestone 1A: Type Alignment](#milestone-1a-type-alignment)
  - [Milestone 1B: Worker Security](#milestone-1b-worker-security-fixes)
  - [Milestone 1C: Worker Manager](#milestone-1c-worker-manager-fixes)
  - [Milestone 1D: IPC and Lifecycle](#milestone-1d-ipc-and-lifecycle-fixes)
  - [Verification Gate 1](#milestone-1e-verification-gate)
- [Phase 2: Important Fixes](#phase-2-important-fixes)
  - [Milestone 2A: Main Process](#milestone-2a-main-process-fixes)
  - [Milestone 2B: Query Router](#milestone-2b-query-router-fix)
  - [Milestone 2C: Renderer](#milestone-2c-renderer-fixes)
  - [Milestone 2D: Worker Logging](#milestone-2d-worker-logging-fixes)
  - [Milestone 2E: Type Narrowing](#milestone-2e-type-narrowing-fixes)
  - [Verification Gate 2](#milestone-2f-verification-gate)
- [Phase 3: Documentation Fixes](#phase-3-documentation-and-comment-fixes)
- [Commit Sequence](#execution-order-recommended-commit-sequence)
- [Test Count Summary](#estimated-test-count-summary)

---

## Dependency Graph

```
C9 (type alignment)
  ├── I12 (safe casts — needs aligned Zod types)
  ├── I13 (ErrorCode narrowing — shared types)
  └── I14 (Tab discriminated union — shared types)

C5 (IPC error boundaries) ──> uses DatspaceError from errors.ts
C6 (loadURL await) ──> I1 (activate — depends on lifecycle.ts changes)
C9 (type alignment) ──> I9 (arrow-error details — depends on types.ts ArrowBatch)

All other issues are independent and can be parallelized.
```

---

## Phase 1: Critical Fixes (Must Fix Before Merge)

### Milestone 1A: Type Alignment

#### C9: TypeScript-Zod Type Divergence

**Problem**: `WorkerMessage` union in `src/shared/types.ts:313` has 12 members but Zod schemas define 18 distinct message types. At least 6 types (`error`, `port-ready`, `table_list`, `query_history_record`, `list_tables`, `port`) exist only in Zod with no TypeScript interface in types.ts.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/shared/types.ts` | 312-326 | Replace manual `WorkerMessage` union with Zod-inferred re-exports |
| `src/shared/schemas/worker-schemas.ts` | 188-202 | Add `integrityOk` to `WorkerReadyMessageSchema` metadata |

**Test file**: `tests/unit/shared/schema-type-alignment.test.ts` (new)

**TDD Steps**:

RED — Write compile-time type assertions verifying Zod-inferred types are assignable to `WorkerMessage` and vice versa:
```typescript
import type { WorkerOutboundMessage, WorkerInboundMessage } from '@shared/schemas/worker-schemas';

// Compile-time: verify every outbound Zod type is a valid WorkerMessage
type AssertOutboundCompat = WorkerOutboundMessage extends WorkerMessage ? true : never;
const _check: AssertOutboundCompat = true; // FAILS — types diverge
```

GREEN —
1. Export `type WorkerInboundMessage = z.infer<typeof WorkerInboundMessageSchema>` and `type WorkerOutboundMessage = z.infer<typeof WorkerOutboundMessageSchema>` from `worker-schemas.ts`
2. In `types.ts`, replace the manual `WorkerMessage` union with: `export type WorkerMessage = WorkerInboundMessage | WorkerOutboundMessage`
3. Keep individual interface exports (`WorkerReadyMessage`, `HeartbeatAck`, etc.) for direct import use
4. Add `integrityOk?: boolean | undefined` to `WorkerReadyMessageSchema`'s metadata to match what `duckdb-worker.ts:483` actually sends

REFACTOR — Update any imports that rely on the old union's member count. Verify `npm run typecheck` passes.

**Tests**: 3 (type compat for outbound, inbound, and bidirectional)

---

### Milestone 1B: Worker Security Fixes

#### C1: SQL Injection in handleConfigure

**Problem**: `src/workers/duckdb-worker.ts:355-357` interpolates user-supplied strings directly into SQL SET commands:
```typescript
if (settings.memory_limit) await conn.run(`SET memory_limit = '${settings.memory_limit}'`);
if (settings.threads) await conn.run(`SET threads = ${settings.threads}`);
if (settings.temp_directory) await conn.run(`SET temp_directory = '${settings.temp_directory}'`);
```
The `config:set` IPC handler (ipc-handlers.ts:188) allows the renderer to set arbitrary config values, which flow through to these SQL statements.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/workers/duckdb-worker.ts` | 352-358 | Add input validation before SQL execution |

**Test file**: `tests/unit/workers/duckdb-worker.test.ts` — add to existing `configure` describe block

**TDD Steps**:

RED — Write tests sending malicious config values:
```typescript
describe('handleConfigure input validation', () => {
  it('rejects memory_limit with SQL injection attempt', async () => {
    await handler({ type: 'configure', settings: { memory_limit: "1GB'; DROP TABLE users; --" } });
    expect(mockRun).not.toHaveBeenCalled();
    expect(errorPosted()).toBeTruthy();
  });

  it('rejects threads with non-positive integer', async () => {
    await handler({ type: 'configure', settings: { threads: -1 } });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('rejects temp_directory with quotes or semicolons', async () => {
    await handler({ type: 'configure', settings: { temp_directory: "/tmp'; --" } });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('accepts valid memory_limit like "4GB"', async () => {
    await handler({ type: 'configure', settings: { memory_limit: '4GB' } });
    expect(mockRun).toHaveBeenCalledWith(expect.stringContaining('4GB'));
  });

  it('accepts valid threads like 4', async () => {
    await handler({ type: 'configure', settings: { threads: 4 } });
    expect(mockRun).toHaveBeenCalledWith(expect.stringContaining('4'));
  });

  it('accepts valid temp_directory', async () => {
    await handler({ type: 'configure', settings: { temp_directory: '/tmp/datspace' } });
    expect(mockRun).toHaveBeenCalledWith(expect.stringContaining('/tmp/datspace'));
  });

  it('applies valid settings and skips invalid ones', async () => {
    await handler({ type: 'configure', settings: { memory_limit: '4GB', threads: -1 } });
    expect(mockRun).toHaveBeenCalledTimes(1); // Only memory_limit applied
  });
});
```

GREEN — Add validation functions before the SET statements:
```typescript
const MEMORY_LIMIT_RE = /^\d+(\.\d+)?\s*(B|KB|MB|GB|TB)$/i;
const TEMP_DIR_RE = /^[^'";]+$/;

async function handleConfigure(msg: WorkerConfigUpdate): Promise<void> {
  const conn = getConnection();
  const { settings } = msg;

  if (settings.memory_limit) {
    if (!MEMORY_LIMIT_RE.test(settings.memory_limit.trim())) {
      port.postMessage({ type: 'error', message: `Invalid memory_limit: ${settings.memory_limit}` });
      return;
    }
    await conn.run(`SET memory_limit = '${settings.memory_limit}'`);
  }
  if (settings.threads) {
    if (!Number.isInteger(settings.threads) || settings.threads <= 0) {
      port.postMessage({ type: 'error', message: `Invalid threads: ${settings.threads}` });
      return;
    }
    await conn.run(`SET threads = ${settings.threads}`);
  }
  if (settings.temp_directory) {
    if (!TEMP_DIR_RE.test(settings.temp_directory)) {
      port.postMessage({ type: 'error', message: `Invalid temp_directory: ${settings.temp_directory}` });
      return;
    }
    await conn.run(`SET temp_directory = '${settings.temp_directory}'`);
  }
}
```

REFACTOR — Consider extracting validators into a shared utility if reused.

**Tests**: 7

---

#### C2: arrow-stream.ts Uses `'node:worker_threads'`

**Problem**: `src/workers/arrow-stream.ts:9` imports from `'node:worker_threads'` but Vite externals in `vite.main.config.ts:29,53` only externalize `'worker_threads'` (without `node:` prefix). This would cause a build failure for the worker bundle.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/workers/arrow-stream.ts` | 9 | Change `'node:worker_threads'` → `'worker_threads'` |

**Test file**: `tests/unit/workers/arrow-stream.test.ts` (existing — verify import works)

**TDD Steps**:

RED — This is a type-only import, so a build verification test is appropriate. Existing arrow-stream tests already import the module; they will validate the fix compiles.

GREEN — Change line 9:
```typescript
// Before: import type { MessagePort } from 'node:worker_threads';
// After:
import type { MessagePort } from 'worker_threads';
```

REFACTOR — None needed.

**Tests**: 0 (verified by existing tests + `npm run typecheck`)

**Verification**: `npm run typecheck && npm run package`

---

#### C8: Data Plane Messages Dropped When dataPort is Null

**Problem**: `src/workers/duckdb-worker.ts:368-374` — `sendDataPlaneMessage()` and `sendDataPlaneTransfer()` silently return when `dataPort` is null. Queries appear to execute but results never arrive at the renderer.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/workers/duckdb-worker.ts` | 368-374 | Post error to control plane when dataPort is null |

**Test file**: `tests/unit/workers/duckdb-worker.test.ts`

**TDD Steps**:

RED —
```typescript
describe('sendDataPlaneMessage when dataPort is null', () => {
  it('posts error to control plane when dataPort is null during query', async () => {
    await loadWorker();
    const handler = getMessageHandler();
    // Do NOT set up data port
    mockGetConnection.mockReturnValue({ run: mockRun });
    mockRun.mockResolvedValueOnce(createMockResult([[new Uint8Array([1,2,3])]]));

    await handler({ type: 'execute_query', queryId: 'q-no-port', sql: 'SELECT 1' });

    const errorCall = mockParentPort.postMessage.mock.calls.find(
      (c) => c[0]?.type === 'error' && c[0]?.message?.includes('data port'),
    );
    expect(errorCall).toBeDefined();
  });
});
```

GREEN — Modify both functions to post error on null dataPort:
```typescript
function sendDataPlaneMessage(message: Record<string, unknown>): void {
  if (dataPort) {
    dataPort.postMessage(message);
  } else {
    console.warn('Data port not established, cannot send:', message['type']);
    port.postMessage({
      type: 'error',
      message: `Data port not established; cannot send ${String(message['type'])} for query ${String(message['queryId'])}`,
    });
  }
}

function sendDataPlaneTransfer(envelope: Record<string, unknown>, buffer: ArrayBuffer): void {
  if (dataPort) {
    dataPort.postMessage({ ...envelope, buffer }, [buffer]);
  } else {
    console.warn('Data port not established, cannot transfer:', envelope['type']);
    port.postMessage({
      type: 'error',
      message: `Data port not established; cannot transfer ${String(envelope['type'])} for query ${String(envelope['queryId'])}`,
    });
  }
}
```

REFACTOR — Extract shared error logic into helper.

**Tests**: 3 (null port during batch send, during end send, during error send)

---

### Milestone 1C: Worker Manager Fixes

#### C3: Heartbeat Timeout is a No-Op

**Problem**: `src/main/worker-manager.ts:163-174` — `sendHeartbeat()` has an empty `setTimeout` callback. There is no `consecutiveMisses` counter, no miss tracking, and no degradation trigger. The `HEALTH_CHECK.MAX_CONSECUTIVE_MISSES` constant (value: 2) exists in `src/shared/constants.ts` but is never used.

**Current code** (lines 170-173):
```typescript
setTimeout(() => {
  // If we haven't received an ack, count as a miss
  // The ack handler resets consecutiveMisses
}, this.config.heartbeatTimeoutMs);
```

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/worker-manager.ts` | 36-44 | Add `private consecutiveMisses = 0` field |
| `src/main/worker-manager.ts` | 163-174 | Implement miss counting in timeout body |
| `src/main/worker-manager.ts` | 220-228 | Reset `consecutiveMisses` in `handleHeartbeatAck` |

**Test file**: `tests/unit/main/worker-manager.test.ts` — add `heartbeat miss detection` describe block

**TDD Steps**:

RED —
```typescript
describe('heartbeat miss detection', () => {
  it('increments miss counter when heartbeat times out without ack', async () => {
    const spawnPromise = manager.spawn();
    triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
    await spawnPromise;
    manager.startHealthMonitoring();

    // Advance to first heartbeat interval
    vi.advanceTimersByTime(60_000);
    // Let heartbeat timeout elapse (5s default) without ack
    vi.advanceTimersByTime(5_000);

    // After 1 miss, still ready (threshold is 2)
    expect(manager.getStatus()).toBe('ready');
  });

  it('sets status to degraded after MAX_CONSECUTIVE_MISSES timeouts', async () => {
    const spawnPromise = manager.spawn();
    triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
    await spawnPromise;
    manager.startHealthMonitoring();

    // First heartbeat + timeout (miss 1)
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(5_000);
    // Second heartbeat + timeout (miss 2 = MAX)
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(5_000);

    expect(manager.getStatus()).toBe('degraded');
  });

  it('resets miss counter on heartbeat ack', async () => {
    const spawnPromise = manager.spawn();
    triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
    await spawnPromise;
    manager.startHealthMonitoring();

    // First heartbeat + timeout (miss 1)
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(5_000);
    // Second heartbeat, but ack arrives this time
    vi.advanceTimersByTime(60_000);
    triggerWorkerMessage({ type: 'heartbeat_ack', sentAt: Date.now(), status: 'healthy' });

    // Third heartbeat + timeout (miss 1 since reset, not 3)
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(5_000);

    expect(manager.getStatus()).not.toBe('degraded');
  });

  it('pushes degraded health to renderer on threshold breach', async () => {
    const win = createMockBrowserWindow();
    manager.setMainWindow(win as any);
    // ... trigger 2 misses ...
    const degradedPush = win.webContents.send.mock.calls.find(
      (c) => c[1]?.status === 'degraded',
    );
    expect(degradedPush).toBeDefined();
  });

  it('does not double-degrade on subsequent misses', async () => {
    // After already degraded, additional misses don't re-push
  });
});
```

GREEN — Add field and implement:
```typescript
// New field (line ~44)
private consecutiveMisses = 0;

// Updated sendHeartbeat (lines 163-174)
private sendHeartbeat(): void {
  if (!this.worker || this.status === 'failed') return;
  const sentAt = Date.now();
  this.worker.postMessage({ type: 'heartbeat', sentAt });
  setTimeout(() => {
    this.consecutiveMisses++;
    if (this.consecutiveMisses >= HEALTH_CHECK.MAX_CONSECUTIVE_MISSES) {
      this.setStatus('degraded');
    }
  }, this.config.heartbeatTimeoutMs);
}

// Updated handleHeartbeatAck (line ~220)
private handleHeartbeatAck(ack: HeartbeatAck): void {
  this.consecutiveMisses = 0;  // Reset on successful ack
  // ... rest unchanged
}
```

Import `HEALTH_CHECK` from `@shared/constants` (already has `MAX_CONSECUTIVE_MISSES: 2`).

REFACTOR — Consider tracking timeout IDs for cleanup on shutdown.

**Tests**: 5

---

#### C4: attemptRestart Swallows Spawn Errors

**Problem**: `src/main/worker-manager.ts:256-261` — catch block sets status to 'failed' but doesn't log the error or push health update.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/worker-manager.ts` | 256-261 | Add error logging in catch block |

**Test file**: `tests/unit/main/worker-manager.test.ts`

**TDD Steps**:

RED —
```typescript
it('logs error when spawn fails during restart', async () => {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Trigger restart where spawn throws
  // ...
  expect(consoleSpy).toHaveBeenCalledWith(
    expect.stringContaining('restart'),
    expect.any(Error),
  );
  consoleSpy.mockRestore();
});

it('pushes failed health to renderer when spawn fails during restart', async () => {
  const win = createMockBrowserWindow();
  manager.setMainWindow(win as any);
  // Trigger restart where spawn throws
  // ...
  const failedPush = win.webContents.send.mock.calls.find(
    (c) => c[1]?.status === 'failed',
  );
  expect(failedPush).toBeDefined();
});
```

GREEN — Update catch block:
```typescript
} catch (err) {
  console.error('DuckDB Worker restart failed:', err);
  this.setStatus('failed');  // setStatus already calls pushHealthToRenderer
}
```

REFACTOR — None needed (`setStatus` already pushes health).

**Tests**: 2

---

### Milestone 1D: IPC and Lifecycle Fixes

#### C5: No Error Boundaries on IPC Handlers

**Problem**: `src/main/ipc-handlers.ts:99-205` — all `ipcMain.handle` callbacks throw raw errors. Electron serializes these via structured clone, losing DatspaceError code/retryable fields.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/ipc-handlers.ts` | 99-205 | Wrap each handler in try/catch returning `IPCError` |

**Test file**: `tests/unit/main/ipc-handlers.test.ts`

**TDD Steps**:

RED —
```typescript
describe('IPC handler error boundaries', () => {
  it('query:execute returns structured IPCError when router throws', async () => {
    const mockRouter = { executeQuery: vi.fn().mockRejectedValue(new Error('boom')) };
    setQueryRouter(mockRouter as any);
    const handler = mockHandlers.get(IPC_CHANNELS.QUERY_EXECUTE)!;
    const result = await handler({}, { sql: 'SELECT 1' });
    expect(result).toHaveProperty('code');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('retryable');
  });

  it('preserves DatspaceError codes through IPC', async () => {
    const mockRouter = {
      executeQuery: vi.fn().mockRejectedValue(
        querySyntaxError('bad sql')
      ),
    };
    setQueryRouter(mockRouter as any);
    const handler = mockHandlers.get(IPC_CHANNELS.QUERY_EXECUTE)!;
    const result = await handler({}, { sql: 'bad' });
    expect(result.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
  });

  it('query:listTables returns IPCError on failure', async () => { /* ... */ });
  it('catalog:preview returns IPCError on failure', async () => { /* ... */ });
  it('handles non-Error throws gracefully', async () => { /* ... */ });
  it('returns IPCError when queryRouter is null', async () => { /* ... */ });
});
```

GREEN — Create a wrapper helper and apply to all query/catalog handlers:
```typescript
function wrapIPCHandler<T>(
  fn: (event: IpcMainInvokeEvent, args: T) => Promise<unknown>,
): (event: IpcMainInvokeEvent, args: T) => Promise<unknown> {
  return async (event, args) => {
    try {
      return await fn(event, args);
    } catch (err) {
      if (err instanceof DatspaceError) return err.toIPCError();
      const classified = classifyDuckDBError(
        err instanceof Error ? err : new Error(String(err)),
      );
      return classified.toIPCError();
    }
  };
}

// Usage:
ipcMain.handle(IPC_CHANNELS.QUERY_EXECUTE, wrapIPCHandler(async (_event, args) => {
  if (!queryRouter) throw new DatspaceError(ERROR_CODES.IPC_TIMEOUT, 'QueryRouter not initialized');
  return await queryRouter.executeQuery(args.sql, args.params);
}));
```

REFACTOR — Apply `wrapIPCHandler` to all query/catalog handlers (QUERY_EXECUTE, QUERY_CANCEL, QUERY_LIST_TABLES, QUERY_DESCRIBE_TABLE, CATALOG_PREVIEW). Config/lifecycle handlers get simpler try/catch.

**Tests**: 6

---

#### C6: loadURL/loadFile Errors Voided

**Problem**: `src/main/lifecycle.ts:103-107` — `void win.loadURL(...)` discards the promise. Renderer load failures are invisible.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/lifecycle.ts` | 103-107 | Await the `loadURL`/`loadFile` call |

**Test file**: `tests/unit/main/lifecycle.test.ts`

**TDD Steps**:

RED —
```typescript
it('propagates loadURL error during startup', async () => {
  mockBrowserWindow.loadURL.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));
  await expect(startupSequence()).rejects.toThrow('ERR_CONNECTION_REFUSED');
});

it('propagates loadFile error during startup', async () => {
  // Set MAIN_WINDOW_VITE_DEV_SERVER_URL to undefined to trigger loadFile path
  mockBrowserWindow.loadFile.mockRejectedValueOnce(new Error('ERR_FILE_NOT_FOUND'));
  await expect(startupSequence()).rejects.toThrow('ERR_FILE_NOT_FOUND');
});
```

GREEN — Change `void` to `await`:
```typescript
if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
  await win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
} else {
  await win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
}
```

If `createWindow` is not already async, make it async and await in `startupSequence`.

REFACTOR — None needed.

**Tests**: 2

---

#### C7: waitForRendererReady Has No Timeout

**Problem**: `src/main/ipc-handlers.ts:214-218` — `waitForRendererReady()` creates a promise that never rejects if the renderer fails to signal ready.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/ipc-handlers.ts` | 214-218 | Add 30s timeout with rejection |

**Test file**: `tests/unit/main/ipc-handlers.test.ts`

**TDD Steps**:

RED —
```typescript
it('waitForRendererReady rejects after 30s timeout', async () => {
  const promise = waitForRendererReady();
  vi.advanceTimersByTime(30_001);
  await expect(promise).rejects.toThrow('timed out');
});

it('waitForRendererReady resolves before timeout on ready signal', async () => {
  const promise = waitForRendererReady();
  const handler = mockHandlers.get(IPC_CHANNELS.LIFECYCLE_READY)!;
  await handler({});
  await expect(promise).resolves.toBeUndefined();
});
```

GREEN —
```typescript
export function waitForRendererReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      rendererReadyResolve = null;
      reject(new Error('Renderer ready signal timed out after 30000ms'));
    }, TIMEOUTS.IPC_DEFAULT);

    rendererReadyResolve = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}
```

Uses existing `TIMEOUTS.IPC_DEFAULT` (30000ms) from `src/shared/constants.ts`.

REFACTOR — None needed.

**Tests**: 2

---

### Milestone 1E: Verification Gate

```bash
npm test                # All unit + integration tests pass
npm run typecheck        # Strict TypeScript compilation
npm run lint             # Biome + ESLint pass
npm run arch             # No cross-process imports
npm run dead-code        # No unused exports
npm run check:all        # Full quality suite
```

**All must pass before proceeding to Phase 2.**

---

## Phase 2: Important Fixes

### Milestone 2A: Main Process Fixes

#### I1: macOS Activate Creates Duplicate Workers

**Problem**: `src/main/index.ts:49-53` — `app.on('activate', ...)` calls `startupSequence()` which spawns a new worker even if one already exists, creating orphaned worker threads.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/lifecycle.ts` | new function | Add `reactivate()` that only creates window, reuses worker/router |
| `src/main/index.ts` | 49-53 | Call `reactivate()` instead of `startupSequence()` |

**Test file**: `tests/unit/main/lifecycle.test.ts`

**TDD Steps**:

RED —
```typescript
describe('reactivate', () => {
  it('creates a new window without spawning a new worker', async () => {
    await startupSequence();
    const spawnCount = mockWorkerManager.spawn.mock.calls.length;
    await reactivate();
    expect(mockWorkerManager.spawn.mock.calls.length).toBe(spawnCount);
  });

  it('creates a new window and connects it to existing query router', async () => {
    await startupSequence();
    await reactivate();
    expect(getMainWindow()).toBeDefined();
  });
});
```

GREEN — Add `reactivate()` to lifecycle.ts:
```typescript
export async function reactivate(): Promise<void> {
  if (!workerManager || !queryRouter) {
    // No existing worker/router — fall back to full startup
    return startupSequence();
  }
  const win = await createWindow();
  mainWindow = win;
  setupDataChannel(win, workerManager.getWorker('duckdb')!);
  await waitForRendererReady();
  pushHealthToRenderer(workerManager, win);
}
```

Update `index.ts` activate handler: `reactivate().catch(console.error)`

REFACTOR — None needed.

**Tests**: 2

---

#### I3: config:set Doesn't Validate Against Zod

**Problem**: `src/main/ipc-handlers.ts:188-199` — CONFIG_SET handler writes config values without Zod validation.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/ipc-handlers.ts` | 188-199 | Add Zod validation after applying change |

**Test file**: `tests/unit/main/ipc-handlers.test.ts`

**TDD Steps**:

RED —
```typescript
it('config:set rejects invalid config value with structured error', async () => {
  const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_SET)!;
  const result = await handler({}, { key: 'ui.fontSize', value: 'not-a-number' });
  expect(result).toHaveProperty('code');
});

it('config:set accepts valid config values', async () => {
  const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_SET)!;
  const result = await handler({}, { key: 'ui.fontSize', value: 16 });
  expect(result).not.toHaveProperty('code');
});

it('config:set validates full config after applying change', async () => {
  const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_SET)!;
  const result = await handler({}, { key: 'duckdb.memoryLimitPercent', value: 200 });
  // Zod clamping should handle this, not reject
  // Verify the persisted value is clamped to 90
});
```

GREEN — After constructing the modified config, validate with `DatspaceConfigSchema.safeParse()`:
```typescript
ipcMain.handle(IPC_CHANNELS.CONFIG_SET, wrapIPCHandler(async (_event, args) => {
  const config = getConfig();
  const keys = args.key.split('.');
  // ... existing key traversal ...
  const parsed = DatspaceConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new DatspaceError(ERROR_CODES.MUTATION_REJECTED, `Invalid config: ${parsed.error.message}`);
  }
  setConfigValue(sectionKey, sectionObj as (typeof config)[typeof sectionKey]);
}));
```

REFACTOR — None needed.

**Tests**: 3

---

#### I4: integrityOk Never Acted Upon

**Problem**: `src/main/worker-manager.ts:209-218` — `handleReady` ignores `metadata.integrityOk` and always sets status to `'ready'`.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/worker-manager.ts` | 209-218 | Check `msg.metadata?.integrityOk`, set `'degraded'` if false |

**Test file**: `tests/unit/main/worker-manager.test.ts`

**TDD Steps**:

RED —
```typescript
it('sets status to degraded when integrityOk is false', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb', metadata: { integrityOk: false } });
  await spawnPromise;
  expect(manager.getStatus()).toBe('degraded');
});

it('sets status to ready when integrityOk is true or missing', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb', metadata: { integrityOk: true } });
  await spawnPromise;
  expect(manager.getStatus()).toBe('ready');
});
```

GREEN — Update `handleReady`:
```typescript
private handleReady(msg: WorkerReadyMessage): void {
  const integrityOk = (msg.metadata as Record<string, unknown> | undefined)?.['integrityOk'] ?? true;
  this.status = integrityOk ? 'ready' : 'degraded';
  if (!integrityOk) {
    console.warn('DuckDB integrity check failed; worker started in degraded mode');
  }
  // ... rest unchanged (resolve readyPromise, set upSince)
}
```

Remove the `eslint-disable @typescript-eslint/no-unused-vars` and rename `_msg` to `msg`.

REFACTOR — After C9 is done, use the Zod-typed `metadata.integrityOk` instead of casting.

**Tests**: 2

---

#### I5: Shutdown `.once('message')` Races

**Problem**: `src/main/worker-manager.ts:354-359` — uses `.once('message')` which consumes the first message regardless of type. Non-shutdown messages (heartbeat_ack, health_check_result) can consume the listener.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/worker-manager.ts` | 348-362 | Use `.on('message')` with type filtering + self-removal |

**Test file**: `tests/unit/main/worker-manager.test.ts`

**TDD Steps**:

RED —
```typescript
it('resolves shutdown even when non-shutdown messages arrive first', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
  await spawnPromise;

  const shutdownPromise = manager.shutdown();

  // Send several non-shutdown messages before shutdown-complete
  triggerWorkerMessage({ type: 'heartbeat_ack', sentAt: Date.now(), status: 'healthy' });
  triggerWorkerMessage({ type: 'health_check_result', status: 'healthy', tables: 0, memoryUsedMB: 100, activeQueries: 0 });
  triggerWorkerMessage({ type: 'shutdown-complete', worker: 'duckdb' });

  await expect(shutdownPromise).resolves.toBeUndefined();
});

it('falls back to force terminate after timeout when shutdown-complete never arrives', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
  await spawnPromise;

  const shutdownPromise = manager.shutdown();
  vi.advanceTimersByTime(5_001);
  await shutdownPromise;

  expect(mockWorkerInstance.terminate).toHaveBeenCalled();
});
```

GREEN — Replace `.once` with `.on` + named handler:
```typescript
const handler = (msg: Record<string, unknown>): void => {
  if (msg['type'] === 'shutdown-complete') {
    clearTimeout(timeout);
    this.worker?.removeListener('message', handler);
    resolve();
  }
};
this.worker?.on('message', handler);
```

REFACTOR — Clean up handler in timeout path too:
```typescript
const timeout = setTimeout(() => {
  this.worker?.removeListener('message', handler);
  this.worker?.terminate();
  resolve();
}, 5000);
```

**Tests**: 2

---

#### I12: Unsafe Casts in WorkerManager

**Problem**: `src/main/worker-manager.ts:179-192` — `handleWorkerMessage()` uses `msg as unknown as WorkerReadyMessage` etc. without any validation.

**Dependency**: Requires C9 (Zod type alignment) to be complete.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/worker-manager.ts` | 176-206 | Add `WorkerOutboundMessageSchema.safeParse` validation |

**Test file**: `tests/unit/main/worker-manager.test.ts`

**TDD Steps**:

RED —
```typescript
it('handles malformed worker message without crashing', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
  await spawnPromise;

  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(() => {
    triggerWorkerMessage({ type: 'heartbeat_ack' }); // missing required fields
  }).not.toThrow();
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid worker message'));
  consoleSpy.mockRestore();
});

it('processes valid worker messages normally after validation', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
  await spawnPromise;
  expect(manager.getStatus()).toBe('ready');
});

it('ignores messages with unknown type field', async () => {
  const spawnPromise = manager.spawn();
  triggerWorkerMessage({ type: 'ready', worker: 'duckdb' });
  await spawnPromise;

  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  triggerWorkerMessage({ type: 'unknown_type', data: 'foo' });
  expect(consoleSpy).toHaveBeenCalled();
  consoleSpy.mockRestore();
});
```

GREEN — Import and use `WorkerOutboundMessageSchema`:
```typescript
import { WorkerOutboundMessageSchema } from '@shared/schemas/worker-schemas';

private handleWorkerMessage(msg: Record<string, unknown>): void {
  const parsed = WorkerOutboundMessageSchema.safeParse(msg);
  if (!parsed.success) {
    console.warn('Invalid worker message:', parsed.error.issues[0]?.message);
    return;
  }
  const validated = parsed.data;
  switch (validated.type) {
    case 'ready':
      this.handleReady(validated);
      break;
    case 'heartbeat_ack':
      this.handleHeartbeatAck(validated);
      break;
    // ... remaining cases using validated (no unsafe casts)
  }
}
```

REFACTOR — Remove all `as unknown as TYPE` casts.

**Tests**: 3

---

### Milestone 2B: Query Router Fix

#### I6: previewTable SQL Escaping is Fragile

**Problem**: `src/main/query-router.ts:194-198` — double-quote escaping via `replace(/"/g, '""')` is fragile. A strict identifier pattern is safer.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/query-router.ts` | 194-198 | Add identifier pattern validation |

**Test file**: `tests/unit/main/query-router.test.ts` (expand existing previewTable tests)

**TDD Steps**:

RED —
```typescript
it('rejects table names with SQL injection characters', async () => {
  await expect(router.previewTable('users; DROP TABLE--')).rejects.toThrow();
});

it('rejects table names with single quotes', async () => {
  await expect(router.previewTable("table'name")).rejects.toThrow();
});

it('rejects empty table names', async () => {
  await expect(router.previewTable('')).rejects.toThrow();
});

it('accepts valid SQL identifier table names', async () => {
  const handle = await router.previewTable('valid_table_123');
  expect(handle.queryId).toBeDefined();
});
```

GREEN — Add strict identifier validation:
```typescript
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async previewTable(tableName: string, limit?: number): Promise<QueryHandle> {
  if (!IDENTIFIER_PATTERN.test(tableName)) {
    throw new DatspaceError(
      ERROR_CODES.QUERY_SYNTAX_ERROR,
      `Invalid table name: "${tableName}". Must be a valid SQL identifier.`,
    );
  }
  // Keep existing double-quote escaping as defense-in-depth
  const safeTable = tableName.replace(/"/g, '""');
  const raw = limit ?? 0;
  const validLimit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 10000) : 100;
  return this.executeQuery(`SELECT * FROM "${safeTable}" LIMIT ${validLimit}`);
}
```

REFACTOR — None needed.

**Tests**: 4

---

### Milestone 2C: Renderer Fixes

#### I2: Module-Level debounceTimer in QueryEditor

**Problem**: `src/renderer/components/QueryEditor.tsx:8` — `let debounceTimer` at module scope is shared across all component instances.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/renderer/components/QueryEditor.tsx` | 7-8, 35-47, 50-54 | Convert to `useRef` |

**Test file**: `tests/unit/renderer/components/QueryEditor.test.tsx`

**TDD Steps**:

RED —
```typescript
it('each QueryEditor instance has independent debounce timers', async () => {
  // Set up two tabs, render two editors
  // Type in one, verify the other's save isn't affected
});

it('cleanup on unmount clears only own timer', async () => {
  // Render, type, unmount, verify no timer leak
});
```

GREEN — Replace module-level variable with `useRef`:
```typescript
// Remove: let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// Inside component:
const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

// In debounceSaveSql:
if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
debounceTimerRef.current = setTimeout(() => { /* ... */ }, 250);

// In cleanup useEffect:
return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current); };
```

REFACTOR — None needed.

**Tests**: 2

---

#### I9: arrow-error Details Discarded in Preload

**Problem**: `src/preload/index.ts:78-91` — arrow-error messages discard the `code` and `message` fields, sending an empty ArrowBatch to the renderer.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/shared/types.ts` | 566-577 | Add `error?: { code: string; message: string }` to `ArrowBatch` |
| `src/preload/index.ts` | 78-91 | Populate error field from arrow-error message |

**Test file**: `tests/unit/preload/preload.test.ts`

**TDD Steps**:

RED —
```typescript
it('propagates arrow-error code and message through ArrowBatch', async () => {
  // Trigger arrow-error message on data port
  triggerDataPortMessage({
    type: 'arrow-error',
    queryId: 'q-err',
    code: 'E1001',
    message: 'Syntax error near SELECT',
    batchesSent: 0,
  });
  // Verify callback receives batch with error field
  expect(lastBatch.error).toEqual({
    code: 'E1001',
    message: 'Syntax error near SELECT',
  });
});

it('non-error batches have no error field', async () => {
  // Trigger arrow-batch message
  expect(lastBatch.error).toBeUndefined();
});
```

GREEN — Update `ArrowBatch` type in `types.ts`:
```typescript
export interface ArrowBatch {
  buffer: ArrayBuffer;
  index: number;
  rowCount: number;
  byteSize: number;
  isLast: boolean;
  error?: { code: string; message: string } | undefined;
}
```

Update preload arrow-error handler:
```typescript
} else if (msg.type === 'arrow-error') {
  const callbacks = dataCallbacks.get(msg.queryId);
  if (callbacks) {
    const batch: ArrowBatch = {
      buffer: new ArrayBuffer(0),
      index: 0,
      rowCount: 0,
      byteSize: 0,
      isLast: true,
      error: { code: msg.code, message: msg.message },
    };
    for (const cb of callbacks) cb(batch);
  }
}
```

REFACTOR — None needed.

**Tests**: 2

---

#### I10: No decodeArrowBatch Error Handling

**Problem**: `src/renderer/lib/arrow-decode.ts:29-55` — `tableFromIPC(buffer)` can throw on corrupt buffers but has no try/catch.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/renderer/lib/arrow-decode.ts` | 29-55 | Wrap in try/catch, return null on failure |

**Test file**: `tests/unit/renderer/arrow-decode.test.ts`

**TDD Steps**:

RED —
```typescript
it('returns null for corrupt Arrow IPC buffer', () => {
  const corrupt = new ArrayBuffer(4);
  new Uint8Array(corrupt).set([0xFF, 0xFF, 0xFF, 0xFF]);
  const result = decodeArrowBatch(corrupt);
  expect(result).toBeNull();
});

it('returns null for zero-length buffer', () => {
  const result = decodeArrowBatch(new ArrayBuffer(0));
  expect(result).toBeNull();
});

it('still decodes valid buffers normally', () => {
  // Use a known valid Arrow IPC buffer
  const result = decodeArrowBatch(validBuffer);
  expect(result).not.toBeNull();
  expect(result!.columns.length).toBeGreaterThan(0);
});
```

GREEN — Change return type and wrap in try/catch:
```typescript
export function decodeArrowBatch(buffer: ArrayBuffer): DecodedBatch | null {
  try {
    const table = tableFromIPC(buffer);
    // ... existing logic ...
    return { columns, numRows, getColumn, getCell };
  } catch (err) {
    console.error('Failed to decode Arrow IPC buffer:', err);
    return null;
  }
}
```

Update callers in `ResultGrid.tsx` to handle null return.

REFACTOR — None needed.

**Tests**: 3

---

#### I11: No React Error Boundary

**Problem**: `src/renderer/App.tsx` has no error boundary. Any render error crashes the entire UI with a blank screen.

**Files to modify**:
| File | Change |
|------|--------|
| `src/renderer/components/ErrorBoundary.tsx` (new) | Create class component with `getDerivedStateFromError` |
| `src/renderer/App.tsx` | Wrap content in `<ErrorBoundary>` |

**Test file**: `tests/unit/renderer/components/ErrorBoundary.test.tsx` (new)

**TDD Steps**:

RED —
```typescript
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';

describe('ErrorBoundary', () => {
  it('renders fallback UI when child throws during render', () => {
    const ThrowingChild = () => { throw new Error('render crash'); };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/something went wrong/i)).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('renders children normally when no error', () => {
    const { getByText } = render(
      <ErrorBoundary>
        <div>Hello World</div>
      </ErrorBoundary>,
    );
    expect(getByText('Hello World')).toBeDefined();
  });

  it('logs error details via componentDidCatch', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingChild = () => { throw new Error('test error'); };

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
```

GREEN — Create `ErrorBoundary.tsx`:
```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Uncaught error in component tree:', error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, textAlign: 'center' }}>
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message}</p>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

In `App.tsx`, wrap the main content:
```tsx
import { ErrorBoundary } from './components/ErrorBoundary';

export function App() {
  return (
    <ErrorBoundary>
      {/* existing content */}
    </ErrorBoundary>
  );
}
```

REFACTOR — None needed.

**Tests**: 3

---

### Milestone 2D: Worker Logging Fixes

#### I7: Six Empty Catch Blocks

**Problem**: Multiple empty catch blocks silently swallow errors with `/* best effort */` comments.

**Locations**:
1. `src/workers/duckdb-worker.ts:166-168` — query history insert (success path)
2. `src/workers/duckdb-worker.ts:198-200` — query history insert (error path)
3. `src/workers/duckdb-worker.ts:253-255` — table metadata column/row counts
4. `src/workers/duckdb-worker.ts:301-303` — row count in getTableInfo
5. `src/workers/duckdb-connection.ts:113-116` — integrity check
6. `src/workers/duckdb-connection.ts:129-131` — checkpoint

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/workers/duckdb-worker.ts` | 166, 198, 253, 301 | Add `console.warn` in each catch |
| `src/workers/duckdb-connection.ts` | 114, 129 | Add `console.warn` in each catch |

**Test files**: `tests/unit/workers/duckdb-worker.test.ts`, `tests/unit/workers/duckdb-connection.test.ts`

**TDD Steps**:

RED — For each catch block, write a test that triggers the error path and asserts `console.warn` is called:
```typescript
it('logs warning when query history insert fails', async () => {
  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Set up connection.run to throw on INSERT into _query_history
  mockRun.mockRejectedValueOnce(new Error('disk full'));
  await handler({ type: 'execute_query', queryId: 'q1', sql: 'SELECT 1' });
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('query history'));
  consoleSpy.mockRestore();
});
```

GREEN — Add `console.warn` to each empty catch:
```typescript
} catch (err) {
  console.warn('Failed to insert query history record:', err instanceof Error ? err.message : String(err));
}
```

REFACTOR — None needed.

**Tests**: 8 (one per catch block, 6 in worker + 2 in connection)

---

#### I8: Config File Read Errors Silent

**Problem**: `src/main/config.ts:60-67` — invalid JSON or read errors are silently ignored.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/main/config.ts` | 65-67 | Add `console.warn` with context |

**Test file**: `tests/unit/main/config.test.ts`

**TDD Steps**:

RED —
```typescript
it('logs warning when config file has invalid JSON', () => {
  const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockReadFileSync.mockReturnValue('{invalid json');
  mockExistsSync.mockReturnValue(true);
  loadConfig();
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('config'));
  consoleSpy.mockRestore();
});

it('still returns valid config when file read fails', () => {
  mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
  mockExistsSync.mockReturnValue(true);
  const config = loadConfig();
  expect(config).toBeDefined();
  expect(config.duckdb).toBeDefined();
});
```

GREEN —
```typescript
} catch (err) {
  console.warn(
    'Failed to read config file, using defaults:',
    err instanceof Error ? err.message : String(err),
  );
}
```

REFACTOR — None needed.

**Tests**: 2

---

### Milestone 2E: Type Narrowing Fixes

#### I13: DatspaceError Constructor Accepts `string` Not `ErrorCode`

**Problem**: `src/shared/errors.ts:169` — constructor parameter `code` is `string`, not `ErrorCode`.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/shared/errors.ts` | 169 | Change `code: string` to `code: ErrorCode` |
| `src/shared/errors.ts` | 58-142 | Type `ERROR_METADATA` as `Record<ErrorCode, ...>` |

**Test file**: `tests/unit/shared/errors.test.ts`

**TDD Steps**:

RED — Add compile-time test:
```typescript
it('rejects invalid error codes at compile time', () => {
  // @ts-expect-error: 'INVALID' is not assignable to ErrorCode
  new DatspaceError('INVALID', 'test');
});
```

GREEN —
1. Export `type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]` from errors.ts
2. Change constructor signature: `constructor(code: ErrorCode, message?: string, ...)`
3. Type `ERROR_METADATA` as `Record<ErrorCode, { name: string; retryable: boolean; defaultMessage: string }>`

REFACTOR — Verify all `new DatspaceError(...)` call sites and factory functions pass valid `ErrorCode` values (they already use `ERROR_CODES.*` constants). Update `classifyDuckDBError` default to use a proper code.

**Tests**: 2 (compile-time: valid accepted, invalid rejected)

---

#### I14: Tab Not a Discriminated Union

**Problem**: `src/shared/types.ts:353-368` — `Tab.state` accepts any state variant regardless of `Tab.type`.

**Files to modify**:
| File | Lines | Change |
|------|-------|--------|
| `src/shared/types.ts` | 352-368 | Convert to discriminated union |

**Test file**: `tests/unit/shared/types-discriminated.test.ts` (new)

**TDD Steps**:

RED — Write type-level tests for narrowing:
```typescript
import type { Tab } from '@shared/types';

function handleTab(tab: Tab) {
  if (tab.type === 'query') {
    // Should narrow state to QueryTabState
    const _sql: string = tab.state.sql; // Should compile
  }
  if (tab.type === 'catalog') {
    // Should narrow state to CatalogTabState
    const _table: string | null = tab.state.selectedTable; // Should compile
  }
}
// @ts-expect-error: type 'query' with CatalogTabState should fail
const bad: Tab = { type: 'query', state: { selectedTable: null }, /* ... */ };
```

GREEN — Convert to discriminated union:
```typescript
interface BaseTab {
  id: string;
  order: number;
  title: string;
  active: boolean;
  lastAccessedAt: string;
}

export interface QueryTab extends BaseTab {
  type: 'query';
  state: QueryTabState;
}

export interface CatalogTab extends BaseTab {
  type: 'catalog';
  state: CatalogTabState;
}

export interface SettingsTab extends BaseTab {
  type: 'settings';
  state: SettingsTabState;
}

export type Tab = QueryTab | CatalogTab | SettingsTab;
```

REFACTOR — Update Dexie table type: `Table<Tab, string>` should still work since `Tab` is still a union. Check any code that constructs `Tab` objects and ensure the type/state pairs match.

**Tests**: 3 (narrowing for each variant)

---

### Milestone 2F: Verification Gate

```bash
npm test                # All tests pass (existing + ~72 new)
npm run typecheck        # Strict TypeScript
npm run lint             # Biome + ESLint
npm run arch             # No cross-process imports
npm run dead-code        # No unused exports
npm run check:all        # Full quality suite
```

---

## Phase 3: Documentation and Comment Fixes

No tests needed — documentation-only changes.

### D1: Fix Startup Step Count
- **File**: `src/main/lifecycle.ts:113` TSDoc
- **Change**: "8-step" → "9-step", list all 9 steps
- Also update `CLAUDE.md` line mentioning "8 steps"

### D2: Fix Shutdown Step Numbering
- **File**: `src/main/lifecycle.ts:191-229`
- **Change**: Remove "Step 5: Config already saved" no-op comment. Renumber:
  - Step 5 → temp directory cleanup
  - Step 6 → quit

### D3: Remove No-Op Heartbeat Comments
- **File**: `src/main/worker-manager.ts:170-173`
- **Change**: After C3 implementation, the comments about `consecutiveMisses` should match actual code. Remove references to nonexistent state.

### D4: Update previewTable TSDoc
- **File**: `src/main/query-router.ts:191`
- **Change**: `@param limit` → `@param limit - Maximum rows (defaults to 100, capped at 10,000)`

### D5: Cross-Reference Duplicate classifyErrorCode
- **Files**: `src/workers/duckdb-worker.ts:376`, `src/workers/arrow-stream.ts:263`
- **Change**: Add TSDoc noting the shared `classifyDuckDBError` in `src/shared/errors.ts`. Explain why local copies exist (worker bundle isolation).

### D6: Deduplicate Preload API Interfaces
- **Files**: `src/shared/types.ts:640-665`, `src/preload/api.ts:24-155`
- **Change**: In `types.ts`, re-export from `api.ts` instead of duplicating:
  ```typescript
  export type { QueryNamespace, CatalogNamespace, LifecycleNamespace, DatspaceAPI } from '@preload/api';
  ```

### D7: Fix classifyDuckDBError Default Fallback Comment
- **File**: `src/shared/errors.ts:395-396`
- **Change**: Update comment to acknowledge the E1001 default is a lossy fallback

### D8: Fix handleHealthCheckResult No-Op Comment
- **File**: `src/main/worker-manager.ts:231-233`
- **Change**: Clarify comment: "No-op: health checks are superseded by heartbeat monitoring. Messages intentionally discarded."

### D9: Fix getHealthRecord Status Mapping Comment
- **File**: `src/main/worker-manager.ts:312`
- **Change**: Add comment explaining why `'starting'` maps to `'ready'`

---

## Execution Order (Recommended Commit Sequence)

| Commit | Issues | Description |
|--------|--------|-------------|
| 1 | C9 | Type alignment (Zod/TypeScript convergence) |
| 2 | C1, C2, C8 | Worker security & correctness |
| 3 | C3, C4 | Worker manager heartbeat + restart |
| 4 | C5, C7 | IPC error boundaries + renderer timeout |
| 5 | C6 | loadURL/loadFile await |
| 6 | I1, I4, I5, I12 | Main process robustness |
| 7 | I3, I6 | Validation (config + previewTable) |
| 8 | I2, I9, I10, I11 | Renderer robustness |
| 9 | I7, I8 | Logging / empty-catch fixes |
| 10 | I13, I14 | Type narrowing |
| 11 | D1-D9 | Documentation fixes |

---

## Estimated Test Count Summary

| Issue | Tests | Test File |
|-------|-------|-----------|
| C1 | 7 | `tests/unit/workers/duckdb-worker.test.ts` |
| C2 | 0 | (verified by typecheck + existing tests) |
| C3 | 5 | `tests/unit/main/worker-manager.test.ts` |
| C4 | 2 | `tests/unit/main/worker-manager.test.ts` |
| C5 | 6 | `tests/unit/main/ipc-handlers.test.ts` |
| C6 | 2 | `tests/unit/main/lifecycle.test.ts` |
| C7 | 2 | `tests/unit/main/ipc-handlers.test.ts` |
| C8 | 3 | `tests/unit/workers/duckdb-worker.test.ts` |
| C9 | 3 | `tests/unit/shared/schema-type-alignment.test.ts` (new) |
| I1 | 2 | `tests/unit/main/lifecycle.test.ts` |
| I2 | 2 | `tests/unit/renderer/components/QueryEditor.test.tsx` |
| I3 | 3 | `tests/unit/main/ipc-handlers.test.ts` |
| I4 | 2 | `tests/unit/main/worker-manager.test.ts` |
| I5 | 2 | `tests/unit/main/worker-manager.test.ts` |
| I6 | 4 | `tests/unit/main/query-router.test.ts` |
| I7 | 8 | `tests/unit/workers/duckdb-worker.test.ts`, `tests/unit/workers/duckdb-connection.test.ts` |
| I8 | 2 | `tests/unit/main/config.test.ts` |
| I9 | 2 | `tests/unit/preload/preload.test.ts` |
| I10 | 3 | `tests/unit/renderer/arrow-decode.test.ts` |
| I11 | 3 | `tests/unit/renderer/components/ErrorBoundary.test.tsx` (new) |
| I12 | 3 | `tests/unit/main/worker-manager.test.ts` |
| I13 | 2 | `tests/unit/shared/errors.test.ts` |
| I14 | 3 | `tests/unit/shared/types-discriminated.test.ts` (new) |
| **Total** | **~71** | **3 new test files, 10 existing test files modified** |

---

## Critical Files Summary

| File | Issues Addressed |
|------|-----------------|
| `src/workers/duckdb-worker.ts` | C1, C8, I7 (3 catch blocks) |
| `src/main/worker-manager.ts` | C3, C4, I4, I5, I12 |
| `src/main/ipc-handlers.ts` | C5, C7, I3 |
| `src/shared/types.ts` | C9, I9, I14 |
| `src/main/lifecycle.ts` | C6, I1, D1, D2 |
| `src/workers/arrow-stream.ts` | C2, D5 |
| `src/main/query-router.ts` | I6, D4 |
| `src/shared/errors.ts` | I13, D7 |
| `src/preload/index.ts` | I9 |
| `src/renderer/components/QueryEditor.tsx` | I2 |
| `src/renderer/lib/arrow-decode.ts` | I10 |
| `src/renderer/App.tsx` | I11 |
| `src/renderer/components/ErrorBoundary.tsx` (new) | I11 |
| `src/main/config.ts` | I8 |
| `src/workers/duckdb-connection.ts` | I7 (2 catch blocks) |
| `src/main/index.ts` | I1 |
| `src/shared/schemas/worker-schemas.ts` | C9 |
