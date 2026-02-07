import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock electron — capture handlers
// --------------------------------------------------------------------------
const mockHandlers = new Map<string, (...args: any[]) => any>();
let mockHandleCallCount = 0;

const mockElectronPort1 = {
  on: vi.fn(),
  start: vi.fn(),
  postMessage: vi.fn(),
};

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: any) => {
      mockHandlers.set(channel, handler);
      mockHandleCallCount++;
    }),
  },
  BrowserWindow: vi.fn(),
  MessageChannelMain: vi.fn(() => ({
    port1: mockElectronPort1,
    port2: { on: vi.fn(), start: vi.fn(), postMessage: vi.fn() },
  })),
  app: {
    getPath: vi.fn(() => '/tmp/test'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// Capture the worker port2 'message' handler so we can simulate worker messages
let workerPort2MessageHandler: ((data: unknown) => void) | null = null;
vi.mock('node:worker_threads', () => ({
  MessageChannel: vi.fn(() => ({
    port1: { on: vi.fn(), postMessage: vi.fn() },
    port2: {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        if (event === 'message') {
          workerPort2MessageHandler = handler;
        }
      }),
      postMessage: vi.fn(),
    },
  })),
}));

vi.mock('@main/config', () => ({
  getConfig: vi.fn(() => ({
    duckdb: { memoryLimitPercent: 50, memoryLimitOverrideMB: null, threads: null, extensions: [] },
    paths: { database: 'test.duckdb', tempDir: 'tmp', config: 'config.json' },
    workers: {
      healthCheckIntervalMs: 60000,
      heartbeatTimeoutMs: 5000,
      maxRestartAttempts: 3,
      v8HeapLimitMB: 512,
    },
    ui: { theme: 'system', fontSize: 14, defaultQueryLimit: 1000 },
    lifecycle: { shutdownTimeoutMs: 6000, walCheckpointOnShutdown: true },
  })),
  setConfigValue: vi.fn(),
  computeMemoryLimit: vi.fn(() => '4096MB'),
}));

import { registerIPCHandlers, setupDataChannel } from '@main/ipc-handlers';
import { IPC_CHANNELS } from '@shared/constants';

describe('IPC Handlers — Regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #1: Duplicate handler registration on macOS activate
  describe('registerIPCHandlers idempotency (#1)', () => {
    // This test must run with a fresh module to test the idempotency guard.
    // Since handlersRegistered is module-level, we call registerIPCHandlers
    // first (sets the flag), then call again (should be a no-op).
    it('does not register duplicate handlers when called twice', () => {
      mockHandlers.clear();
      mockHandleCallCount = 0;
      vi.clearAllMocks();

      registerIPCHandlers();
      const firstCallCount = mockHandleCallCount;
      const channelCount = Object.values(IPC_CHANNELS).length;

      expect(firstCallCount).toBe(channelCount);

      // Calling again should NOT register more handlers
      registerIPCHandlers();
      expect(mockHandleCallCount).toBe(channelCount);
    });
  });

  // #2/#3: Arrow buffer transfer in bridge
  describe('setupDataChannel buffer transfer (#2/#3)', () => {
    beforeEach(() => {
      workerPort2MessageHandler = null;
      vi.clearAllMocks();
    });

    it('passes ArrayBuffer in transfer list when forwarding to renderer', () => {
      const mockWorker = { postMessage: vi.fn() } as any;
      const mockWindow = {
        webContents: { postMessage: vi.fn() },
      } as any;

      setupDataChannel(mockWindow, mockWorker);

      // Simulate worker sending an Arrow batch with a buffer
      expect(workerPort2MessageHandler).not.toBeNull();
      const testBuffer = new ArrayBuffer(64);
      workerPort2MessageHandler!({
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 10,
        byteSize: 64,
        buffer: testBuffer,
      });

      // electronPort1.postMessage should have been called with a transfer list
      expect(mockElectronPort1.postMessage).toHaveBeenCalledTimes(1);
      const [data, transferList] = mockElectronPort1.postMessage.mock.calls[0]!;
      expect(data).toHaveProperty('buffer');
      expect(transferList).toBeInstanceOf(Array);
      expect(transferList).toContain(testBuffer);
    });

    it('forwards buffer property directly, not __transferredBuffers', () => {
      const mockWorker = { postMessage: vi.fn() } as any;
      const mockWindow = {
        webContents: { postMessage: vi.fn() },
      } as any;

      setupDataChannel(mockWindow, mockWorker);

      const testBuffer = new ArrayBuffer(32);
      workerPort2MessageHandler!({
        type: 'arrow-batch',
        queryId: 'q1',
        index: 0,
        rowCount: 5,
        byteSize: 32,
        buffer: testBuffer,
      });

      const [data] = mockElectronPort1.postMessage.mock.calls[0]!;
      // The forwarded data should preserve the buffer property
      expect(data.buffer).toBe(testBuffer);
    });
  });

  // #11: Config key traversal safety
  // Reuse the handlers already registered by the idempotency test above.
  // registerIPCHandlers() is idempotent and the handlers persist in mockHandlers.
  describe('CONFIG_GET with missing intermediate key (#11)', () => {
    beforeEach(() => {
      // Ensure handlers are registered (idempotent — no-op if already done)
      registerIPCHandlers();
    });

    it('returns undefined for missing intermediate key without throwing', async () => {
      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_GET)!;
      // "nonexistent" is not a key in the config, so the second
      // segment traversal should not throw
      const result = await handler({}, { key: 'nonexistent.deep.path' });
      expect(result).toBeUndefined();
    });

    it('returns undefined for valid top-level key with missing nested key', async () => {
      const handler = mockHandlers.get(IPC_CHANNELS.CONFIG_GET)!;
      // "ui" exists but "nonexistent" does not
      const result = await handler({}, { key: 'ui.nonexistent' });
      expect(result).toBeUndefined();
    });
  });
});
