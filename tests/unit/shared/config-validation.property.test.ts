import type { DatspaceConfig } from '@shared/types';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock electron's app module before imports
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/datspace-test'),
  },
}));

// Mock fs module
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import fs from 'node:fs';
import { computeThreadCount, loadConfig } from '@main/config';

describe('config validation properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  describe('memoryLimitPercent clamping', () => {
    it('is always within [10, 90] for any numeric input', () => {
      fc.assert(
        fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (pct) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ duckdb: { memoryLimitPercent: pct } }),
          );
          const config = loadConfig();
          expect(config.duckdb.memoryLimitPercent).toBeGreaterThanOrEqual(10);
          expect(config.duckdb.memoryLimitPercent).toBeLessThanOrEqual(90);
        }),
        { numRuns: 100 },
      );
    });

    it('preserves valid values within range', () => {
      fc.assert(
        fc.property(fc.integer({ min: 10, max: 90 }), (pct) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ duckdb: { memoryLimitPercent: pct } }),
          );
          const config = loadConfig();
          expect(config.duckdb.memoryLimitPercent).toBe(pct);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('worker settings clamping', () => {
    it('healthCheckIntervalMs is always >= 5000', () => {
      fc.assert(
        fc.property(fc.integer({ min: -10000, max: 100000 }), (ms) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ workers: { healthCheckIntervalMs: ms } }),
          );
          const config = loadConfig();
          expect(config.workers.healthCheckIntervalMs).toBeGreaterThanOrEqual(5000);
        }),
        { numRuns: 100 },
      );
    });

    it('heartbeatTimeoutMs is always >= 1000', () => {
      fc.assert(
        fc.property(fc.integer({ min: -10000, max: 100000 }), (ms) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ workers: { heartbeatTimeoutMs: ms } }),
          );
          const config = loadConfig();
          expect(config.workers.heartbeatTimeoutMs).toBeGreaterThanOrEqual(1000);
        }),
        { numRuns: 100 },
      );
    });

    it('maxRestartAttempts is always >= 1', () => {
      fc.assert(
        fc.property(fc.integer({ min: -100, max: 100 }), (n) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ workers: { maxRestartAttempts: n } }),
          );
          const config = loadConfig();
          expect(config.workers.maxRestartAttempts).toBeGreaterThanOrEqual(1);
        }),
        { numRuns: 100 },
      );
    });

    it('v8HeapLimitMB is always >= 128', () => {
      fc.assert(
        fc.property(fc.integer({ min: -1000, max: 10000 }), (mb) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ workers: { v8HeapLimitMB: mb } }),
          );
          const config = loadConfig();
          expect(config.workers.v8HeapLimitMB).toBeGreaterThanOrEqual(128);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('UI settings clamping', () => {
    it('fontSize is always within [10, 24]', () => {
      fc.assert(
        fc.property(fc.integer({ min: -100, max: 200 }), (size) => {
          vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { fontSize: size } }));
          const config = loadConfig();
          expect(config.ui.fontSize).toBeGreaterThanOrEqual(10);
          expect(config.ui.fontSize).toBeLessThanOrEqual(24);
        }),
        { numRuns: 100 },
      );
    });

    it('defaultQueryLimit is always >= 0', () => {
      fc.assert(
        fc.property(fc.integer({ min: -1000, max: 100000 }), (limit) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ ui: { defaultQueryLimit: limit } }),
          );
          const config = loadConfig();
          expect(config.ui.defaultQueryLimit).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 100 },
      );
    });

    it('theme is always a valid value for any string input', () => {
      fc.assert(
        fc.property(fc.string(), (theme) => {
          vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { theme } }));
          const config = loadConfig();
          expect(['light', 'dark', 'system']).toContain(config.ui.theme);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('lifecycle clamping', () => {
    it('shutdownTimeoutMs is always >= 2000', () => {
      fc.assert(
        fc.property(fc.integer({ min: -10000, max: 100000 }), (ms) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ lifecycle: { shutdownTimeoutMs: ms } }),
          );
          const config = loadConfig();
          expect(config.lifecycle.shutdownTimeoutMs).toBeGreaterThanOrEqual(2000);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('thread count', () => {
    it('is always positive when computed from CPU count', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
      loadConfig();
      const threads = computeThreadCount();
      expect(threads).toBeGreaterThanOrEqual(1);
    });

    it('returns explicit value when set', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 128 }), (n) => {
          vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ duckdb: { threads: n } }));
          loadConfig();
          expect(computeThreadCount()).toBe(n);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('config round-trip', () => {
    it('loadConfig output matches what was written to disk', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const config = loadConfig();

      // Verify writeFileSync was called with the validated config
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]!;
      const written = JSON.parse(writeCall[1] as string) as DatspaceConfig;

      expect(written.duckdb.memoryLimitPercent).toBe(config.duckdb.memoryLimitPercent);
      expect(written.ui.theme).toBe(config.ui.theme);
      expect(written.ui.fontSize).toBe(config.ui.fontSize);
      expect(written.workers.healthCheckIntervalMs).toBe(config.workers.healthCheckIntervalMs);
      expect(written.lifecycle.shutdownTimeoutMs).toBe(config.lifecycle.shutdownTimeoutMs);
    });
  });
});
