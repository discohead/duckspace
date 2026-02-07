import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import type { DatspaceConfig } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/constants';

// Mock electron's app module before imports
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/datspace-test'),
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Import after mocks
import fs from 'fs';
import {
  loadConfig,
  saveConfig,
  getConfig,
  getConfigValue,
  setConfigValue,
  computeMemoryLimit,
  computeThreadCount,
  getDatabasePath,
  getTempDirectory,
  ensureDirectories,
} from '@main/config';

// Access the internal deepMerge and validateConfig via module internals
// We test them indirectly through loadConfig

describe('config module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module state by loading with defaults
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  describe('loadConfig', () => {
    it('returns default config when no file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const config = loadConfig();

      expect(config.duckdb.memoryLimitPercent).toBe(DEFAULT_CONFIG.duckdb.memoryLimitPercent);
      expect(config.ui.theme).toBe('system');
      expect(config.paths.database).toBe('analytics.duckdb');
    });

    it('merges file config with defaults', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          ui: { theme: 'dark' },
        }),
      );

      const config = loadConfig();

      expect(config.ui.theme).toBe('dark');
      // Other defaults preserved
      expect(config.ui.fontSize).toBe(DEFAULT_CONFIG.ui.fontSize);
      expect(config.duckdb.memoryLimitPercent).toBe(DEFAULT_CONFIG.duckdb.memoryLimitPercent);
    });

    it('handles invalid JSON gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');

      const config = loadConfig();

      // Should fall back to defaults
      expect(config.ui.theme).toBe('system');
    });

    it('writes back merged config to disk', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      loadConfig();

      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('validateConfig (via loadConfig)', () => {
    it('clamps memoryLimitPercent to 10-90 range', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      // Test below minimum
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { memoryLimitPercent: 5 } }),
      );
      let config = loadConfig();
      expect(config.duckdb.memoryLimitPercent).toBe(10);

      // Test above maximum
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { memoryLimitPercent: 95 } }),
      );
      config = loadConfig();
      expect(config.duckdb.memoryLimitPercent).toBe(90);
    });

    it('clamps worker health check intervals', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          workers: {
            healthCheckIntervalMs: 1000, // below 5000 min
            heartbeatTimeoutMs: 500, // below 1000 min
            maxRestartAttempts: 0, // below 1 min
            v8HeapLimitMB: 64, // below 128 min
          },
        }),
      );

      const config = loadConfig();

      expect(config.workers.healthCheckIntervalMs).toBeGreaterThanOrEqual(5000);
      expect(config.workers.heartbeatTimeoutMs).toBeGreaterThanOrEqual(1000);
      expect(config.workers.maxRestartAttempts).toBeGreaterThanOrEqual(1);
      expect(config.workers.v8HeapLimitMB).toBeGreaterThanOrEqual(128);
    });

    it('clamps font size to 10-24', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ui: { fontSize: 6 } }),
      );
      let config = loadConfig();
      expect(config.ui.fontSize).toBe(10);

      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ui: { fontSize: 72 } }),
      );
      config = loadConfig();
      expect(config.ui.fontSize).toBe(24);
    });

    it('resets invalid theme to system', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ui: { theme: 'neon' } }),
      );

      const config = loadConfig();
      expect(config.ui.theme).toBe('system');
    });

    it('clamps shutdown timeout to minimum 2000ms', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ lifecycle: { shutdownTimeoutMs: 500 } }),
      );

      const config = loadConfig();
      expect(config.lifecycle.shutdownTimeoutMs).toBeGreaterThanOrEqual(2000);
    });

    it('allows defaultQueryLimit of 0', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ ui: { defaultQueryLimit: 0 } }),
      );

      const config = loadConfig();
      expect(config.ui.defaultQueryLimit).toBe(0);
    });
  });

  describe('deepMerge (via loadConfig)', () => {
    it('deep merges nested objects', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          duckdb: { memoryLimitPercent: 70 },
          ui: { fontSize: 16 },
        }),
      );

      const config = loadConfig();

      // Overridden values
      expect(config.duckdb.memoryLimitPercent).toBe(70);
      expect(config.ui.fontSize).toBe(16);
      // Preserved defaults
      expect(config.duckdb.extensions).toEqual(DEFAULT_CONFIG.duckdb.extensions);
      expect(config.ui.theme).toBe('system');
    });

    it('replaces arrays instead of merging them', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          duckdb: { extensions: ['parquet'] },
        }),
      );

      const config = loadConfig();
      expect(config.duckdb.extensions).toEqual(['parquet']);
    });
  });

  describe('saveConfig', () => {
    it('creates directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      saveConfig(DEFAULT_CONFIG);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });

    it('writes JSON with indentation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      saveConfig(DEFAULT_CONFIG);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe(JSON.stringify(DEFAULT_CONFIG, null, 2));
    });
  });

  describe('getConfig', () => {
    it('calls loadConfig when no config is cached', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const config = getConfig();
      expect(config).toBeDefined();
      expect(config.duckdb).toBeDefined();
    });
  });

  describe('getConfigValue', () => {
    it('returns the requested section', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      const ui = getConfigValue('ui');
      expect(ui.theme).toBe('system');
      expect(ui.fontSize).toBe(14);
    });
  });

  describe('setConfigValue', () => {
    it('updates section and persists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      setConfigValue('ui', { theme: 'dark', fontSize: 16, defaultQueryLimit: 500 });

      const ui = getConfigValue('ui');
      expect(ui.theme).toBe('dark');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('computeMemoryLimit', () => {
    it('uses override when set', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { memoryLimitOverrideMB: 2048 } }),
      );
      loadConfig();

      expect(computeMemoryLimit()).toBe('2048MB');
    });

    it('calculates from system memory when no override', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      const result = computeMemoryLimit();
      expect(result).toMatch(/^\d+MB$/);

      // Verify it's ~50% of system memory
      const totalMB = Math.round(os.totalmem() / (1024 * 1024));
      const expectedMB = Math.round(totalMB * 0.5);
      expect(result).toBe(`${expectedMB}MB`);
    });
  });

  describe('computeThreadCount', () => {
    it('uses explicit thread count when set', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { threads: 4 } }),
      );
      loadConfig();

      expect(computeThreadCount()).toBe(4);
    });

    it('defaults to cpus - 2 (minimum 1)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      const expected = Math.max(1, os.cpus().length - 2);
      expect(computeThreadCount()).toBe(expected);
    });
  });

  describe('getDatabasePath', () => {
    it('joins userData path with database filename', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      const dbPath = getDatabasePath();
      expect(dbPath).toContain('analytics.duckdb');
      expect(dbPath).toContain('datspace-test');
    });
  });

  describe('getTempDirectory', () => {
    it('joins userData path with temp dir name', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      const tmpDir = getTempDirectory();
      expect(tmpDir).toContain('tmp');
      expect(tmpDir).toContain('datspace-test');
    });
  });

  describe('ensureDirectories', () => {
    it('creates missing directories', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      ensureDirectories();

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true },
      );
    });
  });
});
