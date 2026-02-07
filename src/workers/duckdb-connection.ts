import { DuckDBInstance } from '@duckdb/node-api';

export interface DuckDBConfig {
  dbPath: string;
  memoryLimit: string;
  threads: number;
  tempDirectory: string;
  extensions: string[];
  /** Optional path to bundled extensions directory (production only) */
  extensionDirectory?: string;
}

let instance: DuckDBInstance | null = null;
let connection: any | null = null;

export async function initDuckDB(config: DuckDBConfig): Promise<void> {
  // Create instance with config
  instance = await DuckDBInstance.create(config.dbPath, {
    access_mode: 'READ_WRITE',
    memory_limit: config.memoryLimit,
    threads: String(config.threads),
    temp_directory: config.tempDirectory,
  });

  connection = await instance.connect();

  // T069: Set extension directory for bundled extensions (production builds)
  if (config.extensionDirectory) {
    await connection.run(`SET extension_directory = '${config.extensionDirectory}'`);
  }

  // Load extensions
  for (const ext of config.extensions) {
    await connection.run(`LOAD ${ext}`);
  }

  // Create system tables
  await createSystemTables();
}

async function createSystemTables(): Promise<void> {
  if (!connection) throw new Error('DuckDB not initialized');

  // Query history table
  await connection.run(`
    CREATE TABLE IF NOT EXISTS _query_history (
      query_id          VARCHAR PRIMARY KEY,
      sql               VARCHAR NOT NULL,
      description       VARCHAR,
      execution_time_ms INTEGER NOT NULL,
      row_count         INTEGER NOT NULL DEFAULT 0,
      timestamp         TIMESTAMP NOT NULL DEFAULT current_timestamp,
      source            VARCHAR NOT NULL DEFAULT 'user',
      tags              VARCHAR[] DEFAULT '{}',
      status            VARCHAR NOT NULL DEFAULT 'success',
      error_message     VARCHAR
    )
  `);

  await connection.run(`
    CREATE INDEX IF NOT EXISTS idx_qh_timestamp
      ON _query_history (timestamp DESC)
  `);

  // Schema version tracking
  await connection.run(`
    CREATE TABLE IF NOT EXISTS _schema_version (
      version     VARCHAR PRIMARY KEY,
      applied_at  TIMESTAMP NOT NULL DEFAULT current_timestamp,
      description VARCHAR
    )
  `);

  // Insert version if not exists
  await connection.run(`
    INSERT OR IGNORE INTO _schema_version (version, description)
    VALUES ('1.0.0', 'Phase 1: Electron Foundation - query history and schema version tracking')
  `);
}

export function getConnection(): any {
  if (!connection) throw new Error('DuckDB not initialized');
  return connection;
}

export function getInstance(): DuckDBInstance {
  if (!instance) throw new Error('DuckDB not initialized');
  return instance;
}

export async function runIntegrityCheck(): Promise<boolean> {
  if (!connection) throw new Error('DuckDB not initialized');
  try {
    const result = await connection.run('PRAGMA integrity_check');
    const rows = await result.getRows();
    return rows[0]?.[0] === 'ok';
  } catch {
    return false;
  }
}

export async function checkpoint(): Promise<void> {
  if (!connection) return;
  try {
    await connection.run('CHECKPOINT');
  } catch {
    // Best effort - WAL replay handles this on next startup
  }
}

export async function closeDuckDB(): Promise<void> {
  if (connection) {
    await checkpoint();
    connection = null;
  }
  instance = null;
}
