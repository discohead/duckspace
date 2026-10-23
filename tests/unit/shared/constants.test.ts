import {
  APP_NAME,
  BACKPRESSURE,
  DATA_CHANNELS,
  DEFAULT_CONFIG,
  DEFAULT_PREFERENCES,
  DEXIE_DB_NAME,
  DEXIE_SCHEMA_VERSION,
  HEALTH_CHECK,
  IPC_CHANNELS,
  PUSH_EVENTS,
  TIMEOUTS,
  WORKER_V8_HEAP_LIMIT_MB,
} from '@shared/constants';
import { describe, expect, it } from 'vitest';

describe('IPC_CHANNELS', () => {
  it('defines all required query channels', () => {
    expect(IPC_CHANNELS.QUERY_EXECUTE).toBe('query:execute');
    expect(IPC_CHANNELS.QUERY_CANCEL).toBe('query:cancel');
    expect(IPC_CHANNELS.QUERY_LIST_TABLES).toBe('query:listTables');
    expect(IPC_CHANNELS.QUERY_DESCRIBE_TABLE).toBe('query:describeTable');
  });

  it('defines lifecycle channels', () => {
    expect(IPC_CHANNELS.LIFECYCLE_READY).toBe('lifecycle:ready');
    expect(IPC_CHANNELS.LIFECYCLE_GET_APP_STATE).toBe('lifecycle:getAppState');
    expect(IPC_CHANNELS.LIFECYCLE_SHUTDOWN_ACK).toBe('lifecycle:shutdownAck');
  });

  it('defines config channels', () => {
    expect(IPC_CHANNELS.CONFIG_GET).toBe('config:get');
    expect(IPC_CHANNELS.CONFIG_SET).toBe('config:set');
    expect(IPC_CHANNELS.CONFIG_GET_ALL).toBe('config:getAll');
  });

  it('has unique channel names', () => {
    const values = Object.values(IPC_CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('PUSH_EVENTS', () => {
  it('defines all push event names', () => {
    expect(PUSH_EVENTS.QUERY_PROGRESS).toBe('query:progress');
    expect(PUSH_EVENTS.QUERY_HISTORY).toBe('query:history');
    expect(PUSH_EVENTS.WORKER_STATUS).toBe('worker:status');
    expect(PUSH_EVENTS.SHUTDOWN_PREPARE).toBe('shutdown-prepare');
    expect(PUSH_EVENTS.PORT).toBe('port');
  });

  it('has unique event names', () => {
    const values = Object.values(PUSH_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('DATA_CHANNELS', () => {
  it('defines the DuckDB data channel', () => {
    expect(DATA_CHANNELS.DUCKDB_DATA).toBe('duckdb-data');
  });
});

describe('TIMEOUTS', () => {
  it('has reasonable IPC defaults', () => {
    expect(TIMEOUTS.IPC_DEFAULT).toBe(30_000);
    expect(TIMEOUTS.IPC_MAX).toBeGreaterThan(TIMEOUTS.IPC_DEFAULT);
  });

  it('has heartbeat timeout shorter than health check interval', () => {
    expect(TIMEOUTS.HEARTBEAT).toBeLessThan(HEALTH_CHECK.INTERVAL_MS);
  });

  it('has shutdown ACK shorter than total shutdown timeout', () => {
    expect(TIMEOUTS.SHUTDOWN_ACK).toBeLessThan(TIMEOUTS.SHUTDOWN_TOTAL);
  });

  it('all values are positive numbers', () => {
    for (const [, value] of Object.entries(TIMEOUTS)) {
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe('BACKPRESSURE', () => {
  it('has positive window size', () => {
    expect(BACKPRESSURE.WINDOW_SIZE).toBeGreaterThan(0);
  });

  it('has target batch size less than max inflight', () => {
    expect(BACKPRESSURE.TARGET_BATCH_SIZE_BYTES).toBeLessThan(BACKPRESSURE.MAX_INFLIGHT_BYTES);
  });
});

describe('HEALTH_CHECK', () => {
  it('heartbeat timeout is less than interval', () => {
    expect(HEALTH_CHECK.HEARTBEAT_TIMEOUT_MS).toBeLessThan(HEALTH_CHECK.INTERVAL_MS);
  });

  it('has at least 1 restart attempt', () => {
    expect(HEALTH_CHECK.MAX_RESTART_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('has valid DuckDB config', () => {
    expect(DEFAULT_CONFIG.duckdb.memoryLimitPercent).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_CONFIG.duckdb.memoryLimitPercent).toBeLessThanOrEqual(90);
    expect(DEFAULT_CONFIG.duckdb.memoryLimitOverrideMB).toBeNull();
    expect(DEFAULT_CONFIG.duckdb.threads).toBeNull();
    expect(DEFAULT_CONFIG.duckdb.extensions).toContain('parquet');
  });

  it('has valid path defaults', () => {
    expect(DEFAULT_CONFIG.paths.database).toBe('analytics.duckdb');
    expect(DEFAULT_CONFIG.paths.tempDir).toBe('tmp');
    expect(DEFAULT_CONFIG.paths.config).toBe('config.json');
  });

  it('has valid worker config', () => {
    expect(DEFAULT_CONFIG.workers.healthCheckIntervalMs).toBeGreaterThanOrEqual(5000);
    expect(DEFAULT_CONFIG.workers.heartbeatTimeoutMs).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_CONFIG.workers.maxRestartAttempts).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.workers.v8HeapLimitMB).toBeGreaterThanOrEqual(128);
  });

  it('has valid UI defaults', () => {
    expect(['light', 'dark', 'system']).toContain(DEFAULT_CONFIG.ui.theme);
    expect(DEFAULT_CONFIG.ui.fontSize).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_CONFIG.ui.fontSize).toBeLessThanOrEqual(24);
    expect(DEFAULT_CONFIG.ui.defaultQueryLimit).toBeGreaterThanOrEqual(0);
  });

  it('has valid lifecycle config', () => {
    expect(DEFAULT_CONFIG.lifecycle.shutdownTimeoutMs).toBeGreaterThanOrEqual(2000);
    expect(typeof DEFAULT_CONFIG.lifecycle.walCheckpointOnShutdown).toBe('boolean');
  });

  // -- Mutant-killing: exact value assertions --------------------------------

  it('walCheckpointOnShutdown defaults to true', () => {
    // Kills: walCheckpointOnShutdown: true → false mutant
    expect(DEFAULT_CONFIG.lifecycle.walCheckpointOnShutdown).toBe(true);
  });

  it('extensions defaults to parquet, json, and icu', () => {
    // Kills: extensions: ['parquet', 'json', 'icu'] → [] mutant
    expect(DEFAULT_CONFIG.duckdb.extensions).toEqual(['parquet', 'json', 'icu']);
  });
});

describe('DEFAULT_PREFERENCES', () => {
  it('has entries for theme, fontSize, and defaultLimit', () => {
    const ids = DEFAULT_PREFERENCES.map((p) => p.id);
    expect(ids).toContain('appearance.theme');
    expect(ids).toContain('appearance.fontSize');
    expect(ids).toContain('editor.defaultLimit');
  });

  it('all entries have category', () => {
    for (const pref of DEFAULT_PREFERENCES) {
      expect(pref.category).toBeTruthy();
    }
  });
});

describe('app metadata', () => {
  it('has correct app name', () => {
    expect(APP_NAME).toBe('Duckspace');
  });

  it('has matching Dexie DB name', () => {
    expect(DEXIE_DB_NAME).toBe('Duckspace');
  });

  it('has schema version >= 1', () => {
    expect(DEXIE_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('has reasonable worker heap limit', () => {
    expect(WORKER_V8_HEAP_LIMIT_MB).toBeGreaterThanOrEqual(128);
  });
});
