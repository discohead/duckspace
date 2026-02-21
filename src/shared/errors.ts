/**
 * Datspace Error Taxonomy
 *
 * Structured error codes and classes for the datspace Electron application.
 * All IPC errors follow the IPCError interface for safe serialization across
 * process boundaries (Main, Worker, Renderer).
 *
 * Code ranges:
 *   E1xxx - Database errors (DuckDB query, schema, resource)
 *   E2xxx - Ingestion errors (file I/O, format, catalog, watch)
 *   E6xxx - System errors (worker lifecycle, IPC, memory)
 */

import type { IPCError } from './types';

// ---------------------------------------------------------------------------
// Error Code Constants
// ---------------------------------------------------------------------------

/**
 * Enumeration of all structured error codes used across the application.
 *
 * E1xxx codes represent database errors (DuckDB query, schema, resource).
 * E2xxx codes represent ingestion errors (file I/O, format, catalog, watch).
 * E6xxx codes represent system errors (worker lifecycle, IPC, memory).
 */
export const ERROR_CODES = {
  // Database errors (E1xxx)
  QUERY_SYNTAX_ERROR: 'E1001',
  QUERY_TIMEOUT: 'E1002',
  QUERY_CANCELLED: 'E1003',
  TABLE_NOT_FOUND: 'E1004',
  COLUMN_NOT_FOUND: 'E1005',
  TYPE_MISMATCH: 'E1006',
  OUT_OF_MEMORY: 'E1007',
  DISK_FULL: 'E1008',
  DATABASE_CORRUPT: 'E1010',
  MUTATION_REJECTED: 'E1012',
  UNKNOWN_DATABASE_ERROR: 'E1099',

  // Ingestion errors (E2xxx)
  FILE_NOT_FOUND: 'E2001',
  UNSUPPORTED_FORMAT: 'E2002',
  PERMISSION_DENIED: 'E2003',
  SOURCE_NOT_FOUND: 'E2010',
  TABLE_DROP_FAILED: 'E2011',
  DIRECTORY_NOT_FOUND: 'E2020',
  NOT_A_DIRECTORY: 'E2021',
  DIRECTORY_PERMISSION_DENIED: 'E2022',
  ALREADY_WATCHING: 'E2023',

  // System errors (E6xxx)
  WORKER_CRASHED: 'E6001',
  WORKER_UNRESPONSIVE: 'E6002',
  IPC_TIMEOUT: 'E6003',
  PORT_DISCONNECTED: 'E6004',
  MEMORY_PRESSURE: 'E6005',
  SHUTTING_DOWN: 'E6006',
} as const satisfies Record<string, string>;

/** Union type of all valid error code string literals (e.g., 'E1001', 'E6003'). */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Error Metadata
// ---------------------------------------------------------------------------

/**
 * Metadata lookup table for error codes, providing human-readable names,
 * retryability flags, and default messages for each error code.
 */
export const ERROR_METADATA: Record<
  ErrorCode,
  { name: string; retryable: boolean; defaultMessage: string }
> = {
  E1001: {
    name: 'QUERY_SYNTAX_ERROR',
    retryable: false,
    defaultMessage: 'SQL syntax error',
  },
  E1002: {
    name: 'QUERY_TIMEOUT',
    retryable: true,
    defaultMessage: 'Query execution timed out',
  },
  E1003: {
    name: 'QUERY_CANCELLED',
    retryable: false,
    defaultMessage: 'Query was cancelled',
  },
  E1004: {
    name: 'TABLE_NOT_FOUND',
    retryable: false,
    defaultMessage: 'Table does not exist',
  },
  E1005: {
    name: 'COLUMN_NOT_FOUND',
    retryable: false,
    defaultMessage: 'Column does not exist',
  },
  E1006: {
    name: 'TYPE_MISMATCH',
    retryable: false,
    defaultMessage: 'Type mismatch in query parameters',
  },
  E1007: {
    name: 'OUT_OF_MEMORY',
    retryable: true,
    defaultMessage: 'DuckDB memory limit exceeded',
  },
  E1008: {
    name: 'DISK_FULL',
    retryable: false,
    defaultMessage: 'Disk space exhausted',
  },
  E1010: {
    name: 'DATABASE_CORRUPT',
    retryable: false,
    defaultMessage: 'Database integrity check failed',
  },
  E1012: {
    name: 'MUTATION_REJECTED',
    retryable: false,
    defaultMessage: 'DDL/DML statement rejected',
  },
  E1099: {
    name: 'UNKNOWN_DATABASE_ERROR',
    retryable: false,
    defaultMessage: 'Unclassified database error',
  },
  E2001: {
    name: 'FILE_NOT_FOUND',
    retryable: false,
    defaultMessage: 'File not found',
  },
  E2002: {
    name: 'UNSUPPORTED_FORMAT',
    retryable: false,
    defaultMessage: 'Unsupported file format',
  },
  E2003: {
    name: 'PERMISSION_DENIED',
    retryable: false,
    defaultMessage: 'Permission denied reading file',
  },
  E2010: {
    name: 'SOURCE_NOT_FOUND',
    retryable: false,
    defaultMessage: 'Data source not found in catalog',
  },
  E2011: {
    name: 'TABLE_DROP_FAILED',
    retryable: true,
    defaultMessage: 'Failed to drop DuckDB table',
  },
  E2020: {
    name: 'DIRECTORY_NOT_FOUND',
    retryable: false,
    defaultMessage: 'Directory not found',
  },
  E2021: {
    name: 'NOT_A_DIRECTORY',
    retryable: false,
    defaultMessage: 'Path is not a directory',
  },
  E2022: {
    name: 'DIRECTORY_PERMISSION_DENIED',
    retryable: false,
    defaultMessage: 'Permission denied reading directory',
  },
  E2023: {
    name: 'ALREADY_WATCHING',
    retryable: false,
    defaultMessage: 'Directory is already being watched',
  },
  E6001: {
    name: 'WORKER_CRASHED',
    retryable: true,
    defaultMessage: 'DuckDB Worker terminated unexpectedly',
  },
  E6002: {
    name: 'WORKER_UNRESPONSIVE',
    retryable: true,
    defaultMessage: 'DuckDB Worker not responding',
  },
  E6003: {
    name: 'IPC_TIMEOUT',
    retryable: true,
    defaultMessage: 'IPC request timed out',
  },
  E6004: {
    name: 'PORT_DISCONNECTED',
    retryable: true,
    defaultMessage: 'MessagePort channel disconnected',
  },
  E6005: {
    name: 'MEMORY_PRESSURE',
    retryable: true,
    defaultMessage: 'System memory pressure detected',
  },
  E6006: {
    name: 'SHUTTING_DOWN',
    retryable: false,
    defaultMessage: 'Application is shutting down',
  },
};

// ---------------------------------------------------------------------------
// DatspaceError Class
// ---------------------------------------------------------------------------

/**
 * Structured error class for all Datspace application errors.
 *
 * Extends `Error` with a machine-readable code, retryability flag, and optional
 * details. Use {@link DatspaceError.toIPCError} to serialize for safe transport
 * across process boundaries (Main, Worker, Renderer).
 */
export class DatspaceError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly details?: Record<string, unknown> | undefined;

  /**
   * Create a new DatspaceError.
   *
   * @param code - Error code from {@link ERROR_CODES} (e.g., 'E1001').
   * @param message - Human-readable message; falls back to the default from {@link ERROR_METADATA}.
   * @param options - Optional retry delay and arbitrary detail payload.
   */
  constructor(
    code: ErrorCode,
    message?: string,
    options?: { retryAfterMs?: number | undefined; details?: Record<string, unknown> | undefined },
  ) {
    const meta = ERROR_METADATA[code];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety for invalid codes
    super(message ?? meta?.defaultMessage ?? 'Unknown error');

    this.name = 'DatspaceError';
    this.code = code;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety for invalid codes
    this.retryable = meta?.retryable ?? false;
    this.retryAfterMs = options?.retryAfterMs;
    this.details = options?.details;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Return a plain object suitable for IPC serialization (no class methods).
   * This is the format that crosses process boundaries via structured clone.
   */
  toIPCError(): IPCError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a QUERY_SYNTAX_ERROR (E1001) for malformed SQL.
 *
 * @param message - The syntax error message from DuckDB.
 * @returns A non-retryable DatspaceError.
 */
export function querySyntaxError(message: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR, message);
}

/**
 * Create a TABLE_NOT_FOUND error (E1004) for missing tables.
 *
 * @param tableName - Name of the table that was not found.
 * @returns A non-retryable DatspaceError.
 */
export function tableNotFoundError(tableName: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.TABLE_NOT_FOUND, `Table '${tableName}' does not exist`);
}

/**
 * Create a COLUMN_NOT_FOUND error (E1005) for missing columns.
 *
 * @param columnName - Name of the column that was not found.
 * @param tableName - Name of the table the column was expected in.
 * @returns A non-retryable DatspaceError.
 */
export function columnNotFoundError(columnName: string, tableName: string): DatspaceError {
  const msg = tableName
    ? `Column '${columnName}' does not exist in table '${tableName}'`
    : `Column '${columnName}' does not exist`;
  return new DatspaceError(ERROR_CODES.COLUMN_NOT_FOUND, msg);
}

/**
 * Create a QUERY_TIMEOUT error (E1002) when a query exceeds its time limit.
 *
 * @param timeoutMs - The timeout threshold in milliseconds that was exceeded.
 * @returns A retryable DatspaceError with retryAfterMs capped at 5000ms.
 */
export function queryTimeoutError(timeoutMs: number): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.QUERY_TIMEOUT,
    `Query execution timed out after ${String(timeoutMs)}ms`,
    { retryAfterMs: Math.min(timeoutMs, 5_000) },
  );
}

/**
 * Create a QUERY_CANCELLED error (E1003) when a query is explicitly cancelled.
 *
 * @param queryId - Identifier of the cancelled query.
 * @returns A non-retryable DatspaceError with the queryId in details.
 */
export function queryCancelledError(queryId: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.QUERY_CANCELLED, `Query '${queryId}' was cancelled`, {
    details: { queryId },
  });
}

/**
 * Create an OUT_OF_MEMORY error (E1007) when DuckDB exceeds its memory limit.
 *
 * @param details - Optional memory usage details (e.g., heapUsed, heapTotal).
 * @returns A retryable DatspaceError with a 1-second retry delay.
 */
export function outOfMemoryError(details?: Record<string, unknown>): DatspaceError {
  return new DatspaceError(ERROR_CODES.OUT_OF_MEMORY, undefined, {
    retryAfterMs: 1_000,
    details,
  });
}

/**
 * Create a WORKER_CRASHED error (E6001) when the DuckDB worker terminates unexpectedly.
 *
 * @param message - Optional crash reason or exit code description.
 * @returns A retryable DatspaceError with a 2-second retry delay.
 */
export function workerCrashedError(message?: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.WORKER_CRASHED,
    message ?? 'DuckDB Worker terminated unexpectedly',
    { retryAfterMs: 2_000 },
  );
}

/**
 * Create a WORKER_UNRESPONSIVE error (E6002) when the worker fails to respond to health checks.
 *
 * @returns A retryable DatspaceError with a 3-second retry delay.
 */
export function workerUnresponsiveError(): DatspaceError {
  return new DatspaceError(ERROR_CODES.WORKER_UNRESPONSIVE, undefined, {
    retryAfterMs: 3_000,
  });
}

/**
 * Create an IPC_TIMEOUT error (E6003) when an IPC request exceeds its deadline.
 *
 * @param channel - The IPC channel name that timed out.
 * @param timeoutMs - The timeout threshold in milliseconds.
 * @returns A retryable DatspaceError with a 1-second retry delay.
 */
export function ipcTimeoutError(channel: string, timeoutMs: number): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.IPC_TIMEOUT,
    `IPC request on channel '${channel}' timed out after ${String(timeoutMs)}ms`,
    { retryAfterMs: 1_000, details: { channel, timeoutMs } },
  );
}

/**
 * Create a SHUTTING_DOWN error (E6006) to reject requests during application shutdown.
 *
 * @returns A non-retryable DatspaceError.
 */
export function shuttingDownError(): DatspaceError {
  return new DatspaceError(ERROR_CODES.SHUTTING_DOWN);
}

/**
 * Create a MUTATION_REJECTED error (E1012) when a DDL/DML statement is blocked.
 *
 * @param sql - The rejected SQL statement (truncated to 200 chars in message, 1000 in details).
 * @returns A non-retryable DatspaceError.
 */
export function mutationRejectedError(sql: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.MUTATION_REJECTED,
    `DDL/DML statement rejected: ${sql.slice(0, 200)}`,
    { details: { sql: sql.slice(0, 1_000) } },
  );
}

/**
 * Create a DATABASE_CORRUPT error (E1010) when a database integrity check fails.
 *
 * @param details - Optional description of the corruption detected.
 * @returns A non-retryable DatspaceError.
 */
export function databaseCorruptError(details?: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.DATABASE_CORRUPT,
    details ?? 'Database integrity check failed',
  );
}

/**
 * Create a PORT_DISCONNECTED error (E6004) when a MessagePort channel is lost.
 *
 * @param channel - The name of the disconnected channel.
 * @returns A retryable DatspaceError with a 1-second retry delay.
 */
export function portDisconnectedError(channel: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.PORT_DISCONNECTED,
    `MessagePort channel '${channel}' disconnected`,
    { retryAfterMs: 1_000, details: { channel } },
  );
}

// ---------------------------------------------------------------------------
// Ingestion Error Factory Functions
// ---------------------------------------------------------------------------

/** Create a FILE_NOT_FOUND error (E2001). */
export function fileNotFoundError(filePath: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.FILE_NOT_FOUND, `File not found: ${filePath}`, {
    details: { filePath },
  });
}

/** Create an UNSUPPORTED_FORMAT error (E2002). */
export function unsupportedFormatError(filePath: string, extension: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.UNSUPPORTED_FORMAT,
    `Unsupported file format: ${extension}`,
    { details: { filePath, extension } },
  );
}

/** Create a PERMISSION_DENIED error (E2003). */
export function filePermissionDeniedError(filePath: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.PERMISSION_DENIED,
    `Permission denied reading file: ${filePath}`,
    { details: { filePath } },
  );
}

/** Create a SOURCE_NOT_FOUND error (E2010). */
export function sourceNotFoundError(dataSourceId: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.SOURCE_NOT_FOUND, `Data source not found: ${dataSourceId}`, {
    details: { dataSourceId },
  });
}

/** Create a TABLE_DROP_FAILED error (E2011). */
export function tableDropFailedError(tableName: string, reason: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.TABLE_DROP_FAILED,
    `Failed to drop table '${tableName}': ${reason}`,
    { retryAfterMs: 1_000, details: { tableName } },
  );
}

/** Create a DIRECTORY_NOT_FOUND error (E2020). */
export function directoryNotFoundError(dirPath: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.DIRECTORY_NOT_FOUND, `Directory not found: ${dirPath}`, {
    details: { dirPath },
  });
}

/** Create a NOT_A_DIRECTORY error (E2021). */
export function notADirectoryError(path: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.NOT_A_DIRECTORY, `Path is not a directory: ${path}`, {
    details: { path },
  });
}

/** Create a DIRECTORY_PERMISSION_DENIED error (E2022). */
export function directoryPermissionDeniedError(dirPath: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.DIRECTORY_PERMISSION_DENIED,
    `Permission denied reading directory: ${dirPath}`,
    { details: { dirPath } },
  );
}

/** Create an ALREADY_WATCHING error (E2023). */
export function alreadyWatchingError(dirPath: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.ALREADY_WATCHING,
    `Directory is already being watched: ${dirPath}`,
    { details: { dirPath } },
  );
}

/** Create an UNKNOWN_DATABASE_ERROR (E1099). */
export function unknownDatabaseError(message: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.UNKNOWN_DATABASE_ERROR, message);
}

// ---------------------------------------------------------------------------
// DuckDB Error Classification
// ---------------------------------------------------------------------------

/**
 * Extracts a file path from a DuckDB I/O error message.
 * DuckDB formats these as: "IO Error: No such file or directory: '/path/to/file'"
 * Falls back to the full message if no path can be extracted.
 */
function extractFilePath(errorMessage: string): string {
  const match = /:\s*['"]([^'"]+)['"]\s*$/.exec(errorMessage);
  return match?.[1] ?? errorMessage;
}

/**
 * Classify a raw DuckDB error into the datspace error taxonomy.
 * Inspects the error message to determine the appropriate structured error code.
 */
export function classifyDuckDBError(error: Error): DatspaceError {
  const msg = error.message.toLowerCase();

  if (msg.includes('syntax error') || msg.includes('parser error')) {
    return querySyntaxError(error.message);
  }
  if (msg.includes('does not exist') && msg.includes('table')) {
    return tableNotFoundError(error.message);
  }
  if (msg.includes('does not exist') && msg.includes('column')) {
    return columnNotFoundError(error.message, '');
  }
  if (msg.includes('out of memory') || msg.includes('memory limit')) {
    return outOfMemoryError();
  }
  if (msg.includes('type mismatch')) {
    return new DatspaceError(ERROR_CODES.TYPE_MISMATCH, error.message);
  }
  if (msg.includes('no such file')) {
    return fileNotFoundError(extractFilePath(error.message));
  }
  if (msg.includes('permission denied')) {
    return filePermissionDeniedError(extractFilePath(error.message));
  }

  // Default fallback: unclassified database error — preserves the original message
  // without misattributing the cause to a specific error category.
  return new DatspaceError(ERROR_CODES.UNKNOWN_DATABASE_ERROR, error.message);
}
