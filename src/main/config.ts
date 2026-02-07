import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '@shared/constants';
import { DatspaceConfigSchema } from '@shared/schemas';
import type { DatspaceConfig } from '@shared/types';
import { app } from 'electron';

let currentConfig: DatspaceConfig | null = null;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function getUserDataPath(): string {
  return app.getPath('userData');
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function validateConfig(config: DatspaceConfig): DatspaceConfig {
  return DatspaceConfigSchema.parse(config);
}

/**
 * Loads the application configuration from disk, merging with defaults.
 *
 * Reads `config.json` from the user data directory, merges with DEFAULT_CONFIG,
 * validates via Zod, and writes the merged result back to disk.
 *
 * @returns The validated, merged configuration.
 */
export function loadConfig(): DatspaceConfig {
  const configPath = getConfigPath();

  let fileConfig: Partial<DatspaceConfig> = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw) as Partial<DatspaceConfig>;
    }
  } catch {
    // Invalid JSON or read error - use defaults
  }

  // Merge with defaults (file overrides defaults)
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    fileConfig as unknown as Record<string, unknown>,
  ) as unknown as DatspaceConfig;

  currentConfig = validateConfig(merged);

  // Write back to disk to ensure file exists with all keys
  saveConfig(currentConfig);

  return currentConfig;
}

/**
 * Persists the configuration to disk as JSON.
 *
 * Creates the parent directory if it does not exist.
 *
 * @param config - The full configuration object to save.
 */
export function saveConfig(config: DatspaceConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  currentConfig = config;
}

/**
 * Returns the current in-memory configuration, loading from disk if needed.
 *
 * @returns The current application configuration.
 */
export function getConfig(): DatspaceConfig {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

/**
 * Returns a top-level section of the configuration.
 *
 * @param section - The configuration section key (e.g., 'duckdb', 'paths').
 * @returns The value of the requested configuration section.
 */
export function getConfigValue<K extends keyof DatspaceConfig>(section: K): DatspaceConfig[K] {
  return getConfig()[section];
}

/**
 * Updates a top-level configuration section and persists to disk.
 *
 * @param section - The configuration section key to update.
 * @param value - The new value for the section.
 */
export function setConfigValue<K extends keyof DatspaceConfig>(
  section: K,
  value: DatspaceConfig[K],
): void {
  const config = getConfig();
  config[section] = value;
  saveConfig(config);
}

/**
 * Computes the DuckDB memory limit based on configuration and system memory.
 *
 * Uses an explicit override if configured, otherwise calculates a percentage
 * of total system memory.
 *
 * @returns A memory limit string in MB format (e.g., "4096MB").
 */
export function computeMemoryLimit(): string {
  const config = getConfig();
  if (config.duckdb.memoryLimitOverrideMB !== null) {
    return `${config.duckdb.memoryLimitOverrideMB}MB`;
  }
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const limitMb = Math.round(totalMb * (config.duckdb.memoryLimitPercent / 100));
  return `${limitMb}MB`;
}

/**
 * Computes the DuckDB thread count based on configuration and available CPUs.
 *
 * Uses an explicit override if configured, otherwise uses CPU count minus 2
 * (minimum 1).
 *
 * @returns The number of threads for DuckDB to use.
 */
export function computeThreadCount(): number {
  const config = getConfig();
  if (config.duckdb.threads !== null) {
    return config.duckdb.threads;
  }
  return Math.max(1, os.cpus().length - 2);
}

/**
 * Returns the absolute path to the DuckDB database file.
 *
 * @returns The full filesystem path to the database.
 */
export function getDatabasePath(): string {
  return path.join(getUserDataPath(), getConfig().paths.database);
}

/**
 * Returns the absolute path to the temporary directory used by DuckDB.
 *
 * @returns The full filesystem path to the temp directory.
 */
export function getTempDirectory(): string {
  return path.join(getUserDataPath(), getConfig().paths.tempDir);
}

/**
 * Creates the user data and temp directories if they do not already exist.
 */
export function ensureDirectories(): void {
  const dirs = [getUserDataPath(), getTempDirectory()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
