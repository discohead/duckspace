/**
 * Datspace Error Taxonomy
 *
 * Structured error codes and classes for the datspace Electron application.
 * All IPC errors follow the IPCError interface for safe serialization across
 * process boundaries (Main, Worker, Renderer).
 *
 * Code ranges:
 *   E1xxx - Database errors (DuckDB query, schema, resource)
 *   E6xxx - System errors (worker lifecycle, IPC, memory)
 */

import type { IPCError } from './types';

// ---------------------------------------------------------------------------
// Error Code Constants
// ---------------------------------------------------------------------------

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

  // System errors (E6xxx)
  WORKER_CRASHED: 'E6001',
  WORKER_UNRESPONSIVE: 'E6002',
  IPC_TIMEOUT: 'E6003',
  PORT_DISCONNECTED: 'E6004',
  MEMORY_PRESSURE: 'E6005',
  SHUTTING_DOWN: 'E6006',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// Error Metadata
// ---------------------------------------------------------------------------

export const ERROR_METADATA: Record<
  string,
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

export class DatspaceError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message?: string,
    options?: { retryAfterMs?: number; details?: Record<string, unknown> },
  ) {
    const meta = ERROR_METADATA[code];
    super(message ?? meta?.defaultMessage ?? 'Unknown error');

    this.name = 'DatspaceError';
    this.code = code;
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

export function querySyntaxError(message: string): DatspaceError {
  return new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR, message);
}

export function tableNotFoundError(tableName: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.TABLE_NOT_FOUND,
    `Table '${tableName}' does not exist`,
  );
}

export function columnNotFoundError(
  columnName: string,
  tableName: string,
): DatspaceError {
  const msg = tableName
    ? `Column '${columnName}' does not exist in table '${tableName}'`
    : `Column '${columnName}' does not exist`;
  return new DatspaceError(ERROR_CODES.COLUMN_NOT_FOUND, msg);
}

export function queryTimeoutError(timeoutMs: number): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.QUERY_TIMEOUT,
    `Query execution timed out after ${timeoutMs}ms`,
    { retryAfterMs: Math.min(timeoutMs, 5_000) },
  );
}

export function queryCancelledError(queryId: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.QUERY_CANCELLED,
    `Query '${queryId}' was cancelled`,
    { details: { queryId } },
  );
}

export function outOfMemoryError(
  details?: Record<string, unknown>,
): DatspaceError {
  return new DatspaceError(ERROR_CODES.OUT_OF_MEMORY, undefined, {
    retryAfterMs: 1_000,
    details,
  });
}

export function workerCrashedError(message?: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.WORKER_CRASHED,
    message ?? 'DuckDB Worker terminated unexpectedly',
    { retryAfterMs: 2_000 },
  );
}

export function workerUnresponsiveError(): DatspaceError {
  return new DatspaceError(ERROR_CODES.WORKER_UNRESPONSIVE, undefined, {
    retryAfterMs: 3_000,
  });
}

export function ipcTimeoutError(
  channel: string,
  timeoutMs: number,
): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.IPC_TIMEOUT,
    `IPC request on channel '${channel}' timed out after ${timeoutMs}ms`,
    { retryAfterMs: 1_000, details: { channel, timeoutMs } },
  );
}

export function shuttingDownError(): DatspaceError {
  return new DatspaceError(ERROR_CODES.SHUTTING_DOWN);
}

export function mutationRejectedError(sql: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.MUTATION_REJECTED,
    `DDL/DML statement rejected: ${sql.slice(0, 200)}`,
    { details: { sql: sql.slice(0, 1_000) } },
  );
}

export function databaseCorruptError(details?: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.DATABASE_CORRUPT,
    details ?? 'Database integrity check failed',
  );
}

export function portDisconnectedError(channel: string): DatspaceError {
  return new DatspaceError(
    ERROR_CODES.PORT_DISCONNECTED,
    `MessagePort channel '${channel}' disconnected`,
    { retryAfterMs: 1_000, details: { channel } },
  );
}

// ---------------------------------------------------------------------------
// DuckDB Error Classification
// ---------------------------------------------------------------------------

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

  // Default: return as syntax error with original message
  return new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR, error.message);
}
