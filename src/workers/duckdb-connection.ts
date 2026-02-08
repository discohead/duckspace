import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

/** Configuration for initializing a DuckDB instance within the worker thread. */
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
let connection: DuckDBConnection | null = null;

/**
 * Initializes the DuckDB instance and connection with the given configuration.
 *
 * Creates the database, opens a connection, loads extensions, and creates
 * system tables (_query_history, _schema_version).
 *
 * @param config - Database path, memory limits, threads, and extensions to load.
 * @throws {@link Error} If instance creation or extension loading fails.
 */
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

  // Install and load the Arrow community extension for to_arrow_ipc() support.
  // Required by the data-plane pipeline to stream Arrow IPC buffers to the renderer.
  // The extension is cached locally after first install (~/.duckdb/extensions/).
  try {
    await connection.run('INSTALL arrow FROM community');
    await connection.run('LOAD arrow');
  } catch (err) {
    console.warn(
      'Failed to load Arrow extension (query streaming will not work):',
      err instanceof Error ? err.message : String(err),
    );
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

/**
 * Returns the active DuckDB connection.
 *
 * @returns The current DuckDB connection.
 * @throws {@link Error} If DuckDB has not been initialized.
 */
export function getConnection(): DuckDBConnection {
  if (!connection) throw new Error('DuckDB not initialized');
  return connection;
}

/**
 * Verifies the DuckDB database connection is functional.
 *
 * Uses a simple connectivity check (SELECT 1) because the PRAGMA integrity_check
 * function does not exist in the DuckDB Neo client (@duckdb/node-api).
 *
 * @returns True if the database responds correctly, false otherwise.
 * @throws {@link Error} If DuckDB has not been initialized.
 */
export async function runIntegrityCheck(): Promise<boolean> {
  if (!connection) throw new Error('DuckDB not initialized');
  try {
    const result = await connection.run('SELECT 1 AS ok');
    const rows = await result.getRows();
    return rows[0]?.[0] === 1;
  } catch (err) {
    console.warn('Integrity check failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Forces a WAL checkpoint to flush data to the main database file.
 *
 * Best-effort operation; failures are silently ignored since WAL replay
 * handles recovery on the next startup.
 */
async function checkpoint(): Promise<void> {
  if (!connection) return;
  try {
    await connection.run('CHECKPOINT');
  } catch (err) {
    console.warn(
      'Checkpoint failed (WAL replay will recover):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Closes the DuckDB connection and releases the instance.
 *
 * Performs a checkpoint before closing to flush pending WAL data.
 */
export async function closeDuckDB(): Promise<void> {
  if (connection) {
    await checkpoint();
    connection.closeSync();
    connection = null;
  }
  if (instance) {
    instance.closeSync();
    instance = null;
  }
}
