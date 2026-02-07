import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  ERROR_METADATA,
  DatspaceError,
  querySyntaxError,
  tableNotFoundError,
  columnNotFoundError,
  queryTimeoutError,
  queryCancelledError,
  outOfMemoryError,
  workerCrashedError,
  workerUnresponsiveError,
  ipcTimeoutError,
  shuttingDownError,
  mutationRejectedError,
  databaseCorruptError,
  portDisconnectedError,
  classifyDuckDBError,
} from '@shared/errors';

// ---------------------------------------------------------------------------
// ERROR_CODES
// ---------------------------------------------------------------------------

describe('ERROR_CODES', () => {
  it('has database error codes starting with E1', () => {
    expect(ERROR_CODES.QUERY_SYNTAX_ERROR).toBe('E1001');
    expect(ERROR_CODES.QUERY_TIMEOUT).toBe('E1002');
    expect(ERROR_CODES.QUERY_CANCELLED).toBe('E1003');
    expect(ERROR_CODES.TABLE_NOT_FOUND).toBe('E1004');
    expect(ERROR_CODES.COLUMN_NOT_FOUND).toBe('E1005');
    expect(ERROR_CODES.TYPE_MISMATCH).toBe('E1006');
    expect(ERROR_CODES.OUT_OF_MEMORY).toBe('E1007');
    expect(ERROR_CODES.DISK_FULL).toBe('E1008');
    expect(ERROR_CODES.DATABASE_CORRUPT).toBe('E1010');
    expect(ERROR_CODES.MUTATION_REJECTED).toBe('E1012');
  });

  it('has system error codes starting with E6', () => {
    expect(ERROR_CODES.WORKER_CRASHED).toBe('E6001');
    expect(ERROR_CODES.WORKER_UNRESPONSIVE).toBe('E6002');
    expect(ERROR_CODES.IPC_TIMEOUT).toBe('E6003');
    expect(ERROR_CODES.PORT_DISCONNECTED).toBe('E6004');
    expect(ERROR_CODES.MEMORY_PRESSURE).toBe('E6005');
    expect(ERROR_CODES.SHUTTING_DOWN).toBe('E6006');
  });
});

// ---------------------------------------------------------------------------
// ERROR_METADATA
// ---------------------------------------------------------------------------

describe('ERROR_METADATA', () => {
  it('has metadata for every error code', () => {
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_METADATA[code]).toBeDefined();
      expect(ERROR_METADATA[code].name).toBeTruthy();
      expect(typeof ERROR_METADATA[code].retryable).toBe('boolean');
      expect(ERROR_METADATA[code].defaultMessage).toBeTruthy();
    }
  });

  it('marks syntax errors as non-retryable', () => {
    expect(ERROR_METADATA[ERROR_CODES.QUERY_SYNTAX_ERROR].retryable).toBe(false);
  });

  it('marks timeout errors as retryable', () => {
    expect(ERROR_METADATA[ERROR_CODES.QUERY_TIMEOUT].retryable).toBe(true);
  });

  it('marks worker errors as retryable', () => {
    expect(ERROR_METADATA[ERROR_CODES.WORKER_CRASHED].retryable).toBe(true);
    expect(ERROR_METADATA[ERROR_CODES.WORKER_UNRESPONSIVE].retryable).toBe(true);
  });

  it('marks shutting down as non-retryable', () => {
    expect(ERROR_METADATA[ERROR_CODES.SHUTTING_DOWN].retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DatspaceError
// ---------------------------------------------------------------------------

describe('DatspaceError', () => {
  it('extends Error', () => {
    const err = new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DatspaceError);
  });

  it('uses default message from metadata when no message provided', () => {
    const err = new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR);
    expect(err.message).toBe('SQL syntax error');
  });

  it('uses custom message when provided', () => {
    const err = new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR, 'Custom msg');
    expect(err.message).toBe('Custom msg');
  });

  it('falls back to "Unknown error" for unknown codes', () => {
    const err = new DatspaceError('E9999');
    expect(err.message).toBe('Unknown error');
    expect(err.retryable).toBe(false);
  });

  it('sets retryable from metadata', () => {
    const retryable = new DatspaceError(ERROR_CODES.QUERY_TIMEOUT);
    expect(retryable.retryable).toBe(true);

    const nonRetryable = new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR);
    expect(nonRetryable.retryable).toBe(false);
  });

  it('sets retryAfterMs and details from options', () => {
    const err = new DatspaceError(ERROR_CODES.OUT_OF_MEMORY, undefined, {
      retryAfterMs: 1000,
      details: { heapUsed: 500 },
    });
    expect(err.retryAfterMs).toBe(1000);
    expect(err.details).toEqual({ heapUsed: 500 });
  });

  it('has correct name property', () => {
    const err = new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR);
    expect(err.name).toBe('DatspaceError');
  });

  describe('toIPCError', () => {
    it('returns a plain object suitable for IPC serialization', () => {
      const err = new DatspaceError(ERROR_CODES.IPC_TIMEOUT, 'timed out', {
        retryAfterMs: 1000,
        details: { channel: 'query:execute' },
      });
      const ipcError = err.toIPCError();

      expect(ipcError).toEqual({
        code: ERROR_CODES.IPC_TIMEOUT,
        message: 'timed out',
        retryable: true,
        retryAfterMs: 1000,
        details: { channel: 'query:execute' },
      });

      // Verify it's a plain object, not a class instance
      expect(ipcError).not.toBeInstanceOf(DatspaceError);
      expect(ipcError).not.toBeInstanceOf(Error);
    });

    it('omits retryAfterMs and details when not set', () => {
      const err = new DatspaceError(ERROR_CODES.QUERY_SYNTAX_ERROR, 'bad sql');
      const ipcError = err.toIPCError();

      expect(ipcError.retryAfterMs).toBeUndefined();
      expect(ipcError.details).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

describe('factory functions', () => {
  describe('querySyntaxError', () => {
    it('creates error with correct code and message', () => {
      const err = querySyntaxError('unexpected token');
      expect(err.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
      expect(err.message).toBe('unexpected token');
      expect(err.retryable).toBe(false);
    });
  });

  describe('tableNotFoundError', () => {
    it('creates error with table name in message', () => {
      const err = tableNotFoundError('users');
      expect(err.code).toBe(ERROR_CODES.TABLE_NOT_FOUND);
      expect(err.message).toContain('users');
      expect(err.retryable).toBe(false);
    });
  });

  describe('columnNotFoundError', () => {
    it('includes table name when provided', () => {
      const err = columnNotFoundError('age', 'users');
      expect(err.code).toBe(ERROR_CODES.COLUMN_NOT_FOUND);
      expect(err.message).toContain('age');
      expect(err.message).toContain('users');
    });

    it('omits table name when empty string', () => {
      const err = columnNotFoundError('age', '');
      expect(err.message).toContain('age');
      expect(err.message).not.toContain('in table');
    });
  });

  describe('queryTimeoutError', () => {
    it('creates retryable error with timeout in message', () => {
      const err = queryTimeoutError(30_000);
      expect(err.code).toBe(ERROR_CODES.QUERY_TIMEOUT);
      expect(err.message).toContain('30000');
      expect(err.retryable).toBe(true);
    });

    it('caps retryAfterMs at 5000', () => {
      const err = queryTimeoutError(60_000);
      expect(err.retryAfterMs).toBe(5_000);
    });

    it('uses timeout as retryAfterMs when under 5000', () => {
      const err = queryTimeoutError(2_000);
      expect(err.retryAfterMs).toBe(2_000);
    });
  });

  describe('queryCancelledError', () => {
    it('includes queryId in message and details', () => {
      const err = queryCancelledError('abc-123');
      expect(err.code).toBe(ERROR_CODES.QUERY_CANCELLED);
      expect(err.message).toContain('abc-123');
      expect(err.details).toEqual({ queryId: 'abc-123' });
      expect(err.retryable).toBe(false);
    });
  });

  describe('outOfMemoryError', () => {
    it('creates retryable error with 1s delay', () => {
      const err = outOfMemoryError();
      expect(err.code).toBe(ERROR_CODES.OUT_OF_MEMORY);
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(1_000);
    });

    it('includes details when provided', () => {
      const err = outOfMemoryError({ heapUsed: 512 });
      expect(err.details).toEqual({ heapUsed: 512 });
    });
  });

  describe('workerCrashedError', () => {
    it('uses default message when none provided', () => {
      const err = workerCrashedError();
      expect(err.code).toBe(ERROR_CODES.WORKER_CRASHED);
      expect(err.message).toBe('DuckDB Worker terminated unexpectedly');
      expect(err.retryAfterMs).toBe(2_000);
    });

    it('uses custom message when provided', () => {
      const err = workerCrashedError('segfault');
      expect(err.message).toBe('segfault');
    });
  });

  describe('workerUnresponsiveError', () => {
    it('creates retryable error with 3s delay', () => {
      const err = workerUnresponsiveError();
      expect(err.code).toBe(ERROR_CODES.WORKER_UNRESPONSIVE);
      expect(err.retryable).toBe(true);
      expect(err.retryAfterMs).toBe(3_000);
    });
  });

  describe('ipcTimeoutError', () => {
    it('includes channel and timeout in message and details', () => {
      const err = ipcTimeoutError('query:execute', 30_000);
      expect(err.code).toBe(ERROR_CODES.IPC_TIMEOUT);
      expect(err.message).toContain('query:execute');
      expect(err.message).toContain('30000');
      expect(err.retryAfterMs).toBe(1_000);
      expect(err.details).toEqual({ channel: 'query:execute', timeoutMs: 30_000 });
    });
  });

  describe('shuttingDownError', () => {
    it('creates non-retryable error', () => {
      const err = shuttingDownError();
      expect(err.code).toBe(ERROR_CODES.SHUTTING_DOWN);
      expect(err.retryable).toBe(false);
    });
  });

  describe('mutationRejectedError', () => {
    it('truncates SQL in message to 200 chars', () => {
      const longSql = 'DROP TABLE ' + 'x'.repeat(300);
      const err = mutationRejectedError(longSql);
      expect(err.code).toBe(ERROR_CODES.MUTATION_REJECTED);
      expect(err.message.length).toBeLessThanOrEqual(250); // prefix + 200 chars
    });

    it('includes full SQL (up to 1000 chars) in details', () => {
      const sql = 'DROP TABLE users';
      const err = mutationRejectedError(sql);
      expect(err.details).toEqual({ sql });
    });
  });

  describe('databaseCorruptError', () => {
    it('uses default message when no details provided', () => {
      const err = databaseCorruptError();
      expect(err.code).toBe(ERROR_CODES.DATABASE_CORRUPT);
      expect(err.message).toBe('Database integrity check failed');
    });

    it('uses provided details as message', () => {
      const err = databaseCorruptError('checksum mismatch');
      expect(err.message).toBe('checksum mismatch');
    });
  });

  describe('portDisconnectedError', () => {
    it('includes channel in message and details', () => {
      const err = portDisconnectedError('duckdb-data');
      expect(err.code).toBe(ERROR_CODES.PORT_DISCONNECTED);
      expect(err.message).toContain('duckdb-data');
      expect(err.retryAfterMs).toBe(1_000);
      expect(err.details).toEqual({ channel: 'duckdb-data' });
    });
  });
});

// ---------------------------------------------------------------------------
// classifyDuckDBError
// ---------------------------------------------------------------------------

describe('classifyDuckDBError', () => {
  it('classifies syntax errors', () => {
    const err = classifyDuckDBError(new Error('Parser Error: syntax error at or near "SELEC"'));
    expect(err.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
  });

  it('classifies parser errors', () => {
    const err = classifyDuckDBError(new Error('parser error in column definition'));
    expect(err.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
  });

  it('classifies table not found errors', () => {
    const err = classifyDuckDBError(new Error('Table "users" does not exist'));
    expect(err.code).toBe(ERROR_CODES.TABLE_NOT_FOUND);
  });

  it('classifies column not found errors', () => {
    const err = classifyDuckDBError(new Error('Referenced column "age" does not exist'));
    expect(err.code).toBe(ERROR_CODES.COLUMN_NOT_FOUND);
  });

  it('classifies out of memory errors', () => {
    const err = classifyDuckDBError(new Error('Out of Memory Error: failed to allocate'));
    expect(err.code).toBe(ERROR_CODES.OUT_OF_MEMORY);
  });

  it('classifies memory limit errors', () => {
    const err = classifyDuckDBError(new Error('exceeded memory limit for query'));
    expect(err.code).toBe(ERROR_CODES.OUT_OF_MEMORY);
  });

  it('classifies type mismatch errors', () => {
    const err = classifyDuckDBError(new Error('Type Mismatch: cannot cast VARCHAR to INTEGER'));
    expect(err.code).toBe(ERROR_CODES.TYPE_MISMATCH);
  });

  it('falls back to syntax error for unknown messages', () => {
    const err = classifyDuckDBError(new Error('something completely unexpected'));
    expect(err.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
    expect(err.message).toBe('something completely unexpected');
  });
});
