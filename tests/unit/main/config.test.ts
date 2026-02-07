import os from 'node:os';
import { DEFAULT_CONFIG } from '@shared/constants';
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
import fs from 'node:fs';
import {
  computeMemoryLimit,
  computeThreadCount,
  ensureDirectories,
  getConfig,
  getConfigValue,
  getDatabasePath,
  getTempDirectory,
  loadConfig,
  saveConfig,
  setConfigValue,
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

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { fontSize: 6 } }));
      let config = loadConfig();
      expect(config.ui.fontSize).toBe(10);

      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { fontSize: 72 } }));
      config = loadConfig();
      expect(config.ui.fontSize).toBe(24);
    });

    it('resets invalid theme to system', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { theme: 'neon' } }));

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
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: { defaultQueryLimit: 0 } }));

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

  describe('deepMerge edge cases (via loadConfig)', () => {
    it('source primitive overwrites target object (Zod rejects the primitive)', () => {
      // File config has a number where DEFAULT_CONFIG has an object (ui section).
      // deepMerge should assign the number directly (source wins), then Zod rejects.
      // Mutant: typeof source[key] === 'object' → true would recurse into the number,
      // returning the target object unchanged, so Zod passes and loadConfig succeeds.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ui: 42 }));

      expect(() => loadConfig()).toThrow();
    });

    it('source string overwrites target object (Zod rejects the string)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ duckdb: 'not-an-object' }));

      expect(() => loadConfig()).toThrow();
    });

    it('source array overwrites target object (Zod rejects the array)', () => {
      // File config has an array where DEFAULT_CONFIG has an object (paths section).
      // deepMerge checks !Array.isArray(source[key]) — array fails this check,
      // so source array is assigned directly. Zod rejects an array for an object field.
      // Mutant: removing !Array.isArray check would try to recurse into the array.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ paths: ['a', 'b', 'c'] }));

      expect(() => loadConfig()).toThrow();
    });

    it('source null overwrites target object (Zod rejects null)', () => {
      // File config has null where DEFAULT_CONFIG has an object (workers section).
      // deepMerge checks source[key] && ... — null is falsy, so condition is false,
      // null is assigned directly. Zod rejects null for an object field.
      // Mutant: && → || would evaluate null || typeof null === 'object' → true
      // (typeof null === 'object' in JS), potentially causing a crash or different behavior.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ lifecycle: null }));

      expect(() => loadConfig()).toThrow();
    });

    it('source object replaces target primitive without recursive merge', () => {
      // Inside duckdb, memoryLimitPercent is a number (50) in DEFAULT_CONFIG.
      // File config provides an object for that field.
      // deepMerge checks typeof target[key] === 'object' — number fails, so
      // source object is assigned directly. Zod rejects an object for a number field.
      // Mutant: typeof target[key] === 'object' → true would try to merge
      // the primitive as a Record, producing a different structure.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { memoryLimitPercent: { nested: true } } }),
      );

      expect(() => loadConfig()).toThrow();
    });

    it('source false-y zero is assigned directly, not merged', () => {
      // 0 is falsy, so source[key] && ... is false — the else branch fires.
      // deepMerge assigns 0 directly. This is valid for Zod (clamped to min 10).
      // Mutant: source[key] → true or && → || could cause recursion attempt.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ duckdb: { memoryLimitPercent: 0 } }),
      );

      const config = loadConfig();
      // Zod clamps 0 to minimum 10
      expect(config.duckdb.memoryLimitPercent).toBe(10);
    });

    it('source empty string is assigned directly, not merged', () => {
      // '' is falsy, so source[key] && ... is false — else branch fires.
      // deepMerge assigns '' directly. Zod accepts empty strings for string fields.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ paths: { database: '' } }));

      const config = loadConfig();
      expect(config.paths.database).toBe('');
    });
  });

  describe('saveConfig', () => {
    it('creates directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      saveConfig(DEFAULT_CONFIG);

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('writes JSON with indentation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      saveConfig(DEFAULT_CONFIG);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string;
      expect(written).toBe(JSON.stringify(DEFAULT_CONFIG, null, 2));
    });

    it('does NOT call mkdirSync when directory already exists', () => {
      // Kills mutant: if (!fs.existsSync(dir)) → if (true)
      // When existsSync returns true, mkdirSync should NOT be called.
      vi.mocked(fs.existsSync).mockReturnValue(true);

      saveConfig(DEFAULT_CONFIG);

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('calls existsSync with the config directory path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      saveConfig(DEFAULT_CONFIG);

      // existsSync should be called with the parent directory of the config path
      expect(fs.existsSync).toHaveBeenCalledWith('/tmp/datspace-test');
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
      const totalMb = Math.round(os.totalmem() / (1024 * 1024));
      const expectedMb = Math.round(totalMb * 0.5);
      expect(result).toBe(`${expectedMb}MB`);
    });
  });

  describe('computeThreadCount', () => {
    it('uses explicit thread count when set', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ duckdb: { threads: 4 } }));
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

      // Clear mocks after loadConfig (which calls saveConfig → mkdirSync)
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.mkdirSync).mockClear();

      ensureDirectories();

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('calls existsSync for each directory (userData and tempDir)', () => {
      // Kills mutant: entire function body emptied → survived
      // Kills mutant: for loop body emptied → survived
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      vi.mocked(fs.existsSync).mockClear();
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDirectories();

      // ensureDirectories checks 2 dirs: userData and tempDir
      // existsSync must be called at least twice (once per directory)
      const existsCalls = vi.mocked(fs.existsSync).mock.calls;
      expect(existsCalls.length).toBeGreaterThanOrEqual(2);

      // Verify the paths checked include userData and temp directory
      const checkedPaths = existsCalls.map((call) => call[0] as string);
      expect(checkedPaths).toContain('/tmp/datspace-test');
      expect(checkedPaths.some((p) => p.includes('tmp'))).toBe(true);
    });

    it('calls mkdirSync with { recursive: true } for each missing directory', () => {
      // Kills mutant: { recursive: true } → { recursive: false } survived
      // Kills mutant: mkdirSync block emptied → survived
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      vi.mocked(fs.existsSync).mockClear();
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.existsSync).mockReturnValue(false);

      ensureDirectories();

      // mkdirSync must be called for both directories
      expect(fs.mkdirSync).toHaveBeenCalledTimes(2);

      // Every call must use { recursive: true }
      for (const call of vi.mocked(fs.mkdirSync).mock.calls) {
        expect(call[1]).toEqual({ recursive: true });
      }
    });

    it('does NOT call mkdirSync when all directories already exist', () => {
      // Kills mutant: !fs.existsSync(dir) → negated / true / false survived
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      vi.mocked(fs.existsSync).mockClear();
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.existsSync).mockReturnValue(true);

      ensureDirectories();

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('only creates directories that do not exist (mixed state)', () => {
      // Kills mutant: !fs.existsSync(dir) → true/false survived
      // One directory exists, one does not
      vi.mocked(fs.existsSync).mockReturnValue(false);
      loadConfig();

      vi.mocked(fs.existsSync).mockClear();
      vi.mocked(fs.mkdirSync).mockClear();

      // First call (userData path) → exists; second call (tempDir path) → doesn't exist
      vi.mocked(fs.existsSync).mockReturnValueOnce(true).mockReturnValueOnce(false);

      ensureDirectories();

      // Only one directory should be created
      expect(fs.mkdirSync).toHaveBeenCalledTimes(1);
      // And it should be called with { recursive: true }
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });
  });
});
