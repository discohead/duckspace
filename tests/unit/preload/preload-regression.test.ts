import { PUSH_EVENTS } from '@shared/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Mock electron module
// --------------------------------------------------------------------------
const handlers = new Map<string, Function>();

vi.mock('electron', () => {
  const h = handlers;
  return {
    contextBridge: {
      exposeInMainWorld: vi.fn(),
    },
    ipcRenderer: {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((channel: string, handler: Function) => {
        h.set(channel, handler);
      }),
      removeListener: vi.fn(),
    },
  };
});

async function loadPreload() {
  await import('@preload/index');
  const electron = await import('electron');
  return electron;
}

function getExposedApi(electron: any) {
  const call = (electron.contextBridge.exposeInMainWorld as ReturnType<typeof vi.fn>).mock
    .calls[0]!;
  return { name: call[0] as string, api: call[1] };
}

function createMockMessagePort(): any {
  return {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    start: vi.fn(),
  };
}

describe('preload — Regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    vi.resetModules();
  });

  // #3: Preload should read msg.buffer, not msg.__transferredBuffers
  describe('arrow-batch reads buffer property (#3)', () => {
    it('uses msg.buffer for Arrow data when present', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      api.query.onData('q1', callback);

      const port = createMockMessagePort();
      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

      // Simulate the REAL message shape from the bridge: has "buffer" property,
      // NOT "__transferredBuffers"
      const testBuffer = new ArrayBuffer(32);
      port.onmessage?.({
        data: {
          type: 'arrow-batch',
          queryId: 'q1',
          index: 0,
          rowCount: 5,
          byteSize: 32,
          buffer: testBuffer,
          // NOTE: No __transferredBuffers — this matches what the bridge actually sends
        },
      } as MessageEvent);

      expect(callback).toHaveBeenCalledOnce();
      const batch = callback.mock.calls[0]![0];
      // The batch buffer should be the actual testBuffer, not an empty ArrayBuffer(0)
      expect(batch.buffer).toBe(testBuffer);
      expect(batch.buffer.byteLength).toBe(32);
    });

    it('falls back to empty ArrayBuffer when no buffer property', async () => {
      const electron = await loadPreload();
      const { api } = getExposedApi(electron);

      const callback = vi.fn();
      api.query.onData('q1', callback);

      const port = createMockMessagePort();
      const portHandler = handlers.get(PUSH_EVENTS.PORT);
      portHandler?.({ ports: [port] }, { channel: 'duckdb-data' });

      port.onmessage?.({
        data: {
          type: 'arrow-batch',
          queryId: 'q1',
          index: 0,
          rowCount: 0,
          byteSize: 0,
          // No buffer, no __transferredBuffers
        },
      } as MessageEvent);

      expect(callback).toHaveBeenCalledOnce();
      const batch = callback.mock.calls[0]![0];
      expect(batch.buffer).toBeInstanceOf(ArrayBuffer);
      expect(batch.buffer.byteLength).toBe(0);
    });
  });
});
