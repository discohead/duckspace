import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { DatspaceConfig } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/constants';

let currentConfig: DatspaceConfig | null = null;

function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function getUserDataPath(): string {
  return app.getPath('userData');
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
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
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function validateConfig(config: DatspaceConfig): DatspaceConfig {
  const c = config;

  // Clamp duckdb memory percent
  c.duckdb.memoryLimitPercent = Math.max(10, Math.min(90, c.duckdb.memoryLimitPercent));

  // Clamp worker health check intervals
  c.workers.healthCheckIntervalMs = Math.max(5000, c.workers.healthCheckIntervalMs);
  c.workers.heartbeatTimeoutMs = Math.max(1000, c.workers.heartbeatTimeoutMs);
  c.workers.maxRestartAttempts = Math.max(1, c.workers.maxRestartAttempts);
  c.workers.v8HeapLimitMB = Math.max(128, c.workers.v8HeapLimitMB);

  // Clamp UI settings
  c.ui.fontSize = Math.max(10, Math.min(24, c.ui.fontSize));
  c.ui.defaultQueryLimit = Math.max(0, c.ui.defaultQueryLimit);
  if (!['light', 'dark', 'system'].includes(c.ui.theme)) {
    c.ui.theme = 'system';
  }

  // Clamp lifecycle
  c.lifecycle.shutdownTimeoutMs = Math.max(2000, c.lifecycle.shutdownTimeoutMs);

  return c;
}

export function loadConfig(): DatspaceConfig {
  const configPath = getConfigPath();

  let fileConfig: Partial<DatspaceConfig> = {};
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    }
  } catch {
    // Invalid JSON or read error - use defaults
  }

  // Merge with defaults (file overrides defaults)
  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    fileConfig as unknown as Record<string, unknown>
  ) as unknown as DatspaceConfig;

  currentConfig = validateConfig(merged);

  // Write back to disk to ensure file exists with all keys
  saveConfig(currentConfig);

  return currentConfig;
}

export function saveConfig(config: DatspaceConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  currentConfig = config;
}

export function getConfig(): DatspaceConfig {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

export function getConfigValue<K extends keyof DatspaceConfig>(section: K): DatspaceConfig[K] {
  return getConfig()[section];
}

export function setConfigValue<K extends keyof DatspaceConfig>(
  section: K,
  value: DatspaceConfig[K]
): void {
  const config = getConfig();
  config[section] = value;
  saveConfig(config);
}

export function computeMemoryLimit(): string {
  const config = getConfig();
  if (config.duckdb.memoryLimitOverrideMB !== null) {
    return `${config.duckdb.memoryLimitOverrideMB}MB`;
  }
  const totalMB = Math.round(os.totalmem() / (1024 * 1024));
  const limitMB = Math.round(totalMB * (config.duckdb.memoryLimitPercent / 100));
  return `${limitMB}MB`;
}

export function computeThreadCount(): number {
  const config = getConfig();
  if (config.duckdb.threads !== null) {
    return config.duckdb.threads;
  }
  return Math.max(1, os.cpus().length - 2);
}

export function getDatabasePath(): string {
  return path.join(getUserDataPath(), getConfig().paths.database);
}

export function getTempDirectory(): string {
  return path.join(getUserDataPath(), getConfig().paths.tempDir);
}

export function ensureDirectories(): void {
  const dirs = [getUserDataPath(), getTempDirectory()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
