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
import { loadConfig } from '@main/config';
import { DEFAULT_CONFIG } from '@shared/constants';

describe('deep merge properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  describe('empty override preserves defaults', () => {
    it('loadConfig with empty object produces config matching all DEFAULT_CONFIG values', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('{}');
      const config = loadConfig();

      expect(config.duckdb.memoryLimitPercent).toBe(DEFAULT_CONFIG.duckdb.memoryLimitPercent);
      expect(config.duckdb.memoryLimitOverrideMB).toBe(DEFAULT_CONFIG.duckdb.memoryLimitOverrideMB);
      expect(config.duckdb.threads).toBe(DEFAULT_CONFIG.duckdb.threads);
      expect(config.duckdb.extensions).toEqual(DEFAULT_CONFIG.duckdb.extensions);
      expect(config.paths.database).toBe(DEFAULT_CONFIG.paths.database);
      expect(config.paths.tempDir).toBe(DEFAULT_CONFIG.paths.tempDir);
      expect(config.paths.config).toBe(DEFAULT_CONFIG.paths.config);
      expect(config.workers.healthCheckIntervalMs).toBe(
        DEFAULT_CONFIG.workers.healthCheckIntervalMs,
      );
      expect(config.workers.heartbeatTimeoutMs).toBe(DEFAULT_CONFIG.workers.heartbeatTimeoutMs);
      expect(config.workers.maxRestartAttempts).toBe(DEFAULT_CONFIG.workers.maxRestartAttempts);
      expect(config.workers.v8HeapLimitMB).toBe(DEFAULT_CONFIG.workers.v8HeapLimitMB);
      expect(config.ui.theme).toBe(DEFAULT_CONFIG.ui.theme);
      expect(config.ui.fontSize).toBe(DEFAULT_CONFIG.ui.fontSize);
      expect(config.ui.defaultQueryLimit).toBe(DEFAULT_CONFIG.ui.defaultQueryLimit);
      expect(config.lifecycle.shutdownTimeoutMs).toBe(DEFAULT_CONFIG.lifecycle.shutdownTimeoutMs);
      expect(config.lifecycle.walCheckpointOnShutdown).toBe(
        DEFAULT_CONFIG.lifecycle.walCheckpointOnShutdown,
      );
    });
  });

  describe('source leaf values win after merge', () => {
    it('any valid ui.fontSize in [10, 24] is preserved exactly', () => {
      fc.assert(
        fc.property(fc.integer({ min: 10, max: 24 }), (size) => {
          vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { fontSize: size } }));
          const config = loadConfig();
          expect(config.ui.fontSize).toBe(size);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('partial section merge preserves other keys', () => {
    it('setting only duckdb.memoryLimitPercent preserves extensions, threads, and memoryLimitOverrideMB', () => {
      fc.assert(
        fc.property(fc.integer({ min: 10, max: 90 }), (pct) => {
          vi.mocked(fs.readFileSync).mockReturnValue(
            JSON.stringify({ duckdb: { memoryLimitPercent: pct } }),
          );
          const config = loadConfig();
          expect(config.duckdb.memoryLimitPercent).toBe(pct);
          expect(config.duckdb.extensions).toEqual(DEFAULT_CONFIG.duckdb.extensions);
          expect(config.duckdb.threads).toBe(DEFAULT_CONFIG.duckdb.threads);
          expect(config.duckdb.memoryLimitOverrideMB).toBe(
            DEFAULT_CONFIG.duckdb.memoryLimitOverrideMB,
          );
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('arrays fully replace, not merge', () => {
    it('setting duckdb.extensions replaces the entire array', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { extensions: ['httpfs'] } }),
      );
      const config = loadConfig();
      expect(config.duckdb.extensions).toEqual(['httpfs']);
      expect(config.duckdb.extensions).not.toContain('parquet');
      expect(config.duckdb.extensions).not.toContain('json');
      expect(config.duckdb.extensions).not.toContain('icu');
    });
  });

  describe('non-mutation of defaults', () => {
    it('successive loadConfig calls with different inputs produce different outputs', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 24 }),
          fc.integer({ min: 10, max: 24 }),
          (sizeA, sizeB) => {
            fc.pre(sizeA !== sizeB);

            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { fontSize: sizeA } }));
            const configA = loadConfig();

            vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { fontSize: sizeB } }));
            const configB = loadConfig();

            expect(configA.ui.fontSize).toBe(sizeA);
            expect(configB.ui.fontSize).toBe(sizeB);
            expect(configA.ui.fontSize).not.toBe(configB.ui.fontSize);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('config round-trip', () => {
    const validConfigArb = fc.record({
      duckdb: fc.record({
        memoryLimitPercent: fc.integer({ min: 10, max: 90 }),
        memoryLimitOverrideMB: fc.constant(null),
        threads: fc.constant(null),
        extensions: fc.constant(['parquet', 'json', 'icu']),
      }),
      paths: fc.record({
        database: fc.constant('analytics.duckdb'),
        tempDir: fc.constant('tmp'),
        config: fc.constant('config.json'),
      }),
      workers: fc.record({
        healthCheckIntervalMs: fc.integer({ min: 5000, max: 120000 }),
        heartbeatTimeoutMs: fc.integer({ min: 1000, max: 30000 }),
        maxRestartAttempts: fc.integer({ min: 1, max: 10 }),
        v8HeapLimitMB: fc.integer({ min: 128, max: 4096 }),
      }),
      ui: fc.record({
        theme: fc.constantFrom('light' as const, 'dark' as const, 'system' as const),
        fontSize: fc.integer({ min: 10, max: 24 }),
        defaultQueryLimit: fc.integer({ min: 0, max: 100000 }),
      }),
      lifecycle: fc.record({
        shutdownTimeoutMs: fc.integer({ min: 2000, max: 30000 }),
        walCheckpointOnShutdown: fc.boolean(),
      }),
    });

    it('merge+validate pipeline is lossless for valid inputs', () => {
      fc.assert(
        fc.property(validConfigArb, (input) => {
          vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(input));
          const config = loadConfig();

          expect(config.duckdb.memoryLimitPercent).toBe(input.duckdb.memoryLimitPercent);
          expect(config.duckdb.memoryLimitOverrideMB).toBe(input.duckdb.memoryLimitOverrideMB);
          expect(config.duckdb.threads).toBe(input.duckdb.threads);
          expect(config.duckdb.extensions).toEqual(input.duckdb.extensions);
          expect(config.paths.database).toBe(input.paths.database);
          expect(config.paths.tempDir).toBe(input.paths.tempDir);
          expect(config.paths.config).toBe(input.paths.config);
          expect(config.workers.healthCheckIntervalMs).toBe(input.workers.healthCheckIntervalMs);
          expect(config.workers.heartbeatTimeoutMs).toBe(input.workers.heartbeatTimeoutMs);
          expect(config.workers.maxRestartAttempts).toBe(input.workers.maxRestartAttempts);
          expect(config.workers.v8HeapLimitMB).toBe(input.workers.v8HeapLimitMB);
          expect(config.ui.theme).toBe(input.ui.theme);
          expect(config.ui.fontSize).toBe(input.ui.fontSize);
          expect(config.ui.defaultQueryLimit).toBe(input.ui.defaultQueryLimit);
          expect(config.lifecycle.shutdownTimeoutMs).toBe(input.lifecycle.shutdownTimeoutMs);
          expect(config.lifecycle.walCheckpointOnShutdown).toBe(
            input.lifecycle.walCheckpointOnShutdown,
          );
        }),
        { numRuns: 100 },
      );
    });
  });
});
