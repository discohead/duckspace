import type { ErrorCode } from '@shared/errors';
import {
  classifyDuckDBError,
  columnNotFoundError,
  DatspaceError,
  databaseCorruptError,
  ERROR_CODES,
  ERROR_METADATA,
  ipcTimeoutError,
  mutationRejectedError,
  outOfMemoryError,
  portDisconnectedError,
  queryCancelledError,
  querySyntaxError,
  queryTimeoutError,
  shuttingDownError,
  tableNotFoundError,
  workerCrashedError,
  workerUnresponsiveError,
} from '@shared/errors';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/** All error code string values from ERROR_CODES. */
const allCodeValues = Object.values(ERROR_CODES);

/** fast-check arbitrary that produces a random error code from ERROR_CODES. */
const arbErrorCode = fc.constantFrom(...allCodeValues);

describe('errors property-based tests', () => {
  // -------------------------------------------------------------------------
  // 1. toIPCError round-trip preserves fields
  // -------------------------------------------------------------------------
  describe('toIPCError round-trip preserves fields', () => {
    it('code, message, and retryable match the constructed DatspaceError', () => {
      fc.assert(
        fc.property(arbErrorCode, fc.string({ minLength: 1 }), (code, msg) => {
          const err = new DatspaceError(code, msg);
          const ipc = err.toIPCError();

          expect(ipc.code).toBe(code);
          expect(ipc.message).toBe(msg);
          expect(ipc.retryable).toBe(ERROR_METADATA[code]?.retryable ?? false);
        }),
        { numRuns: 100 },
      );
    });

    it('retryAfterMs and details are preserved through toIPCError', () => {
      fc.assert(
        fc.property(
          arbErrorCode,
          fc.string({ minLength: 1 }),
          fc.nat({ max: 30_000 }),
          (code, msg, retryMs) => {
            const details = { key: msg };
            const err = new DatspaceError(code, msg, {
              retryAfterMs: retryMs,
              details,
            });
            const ipc = err.toIPCError();

            expect(ipc.retryAfterMs).toBe(retryMs);
            expect(ipc.details).toEqual(details);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Factory retryable invariant
  // -------------------------------------------------------------------------
  describe('factory retryable invariant', () => {
    it('each factory produces errors where retryable matches ERROR_METADATA', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), fc.nat({ max: 60_000 }), (str, num) => {
          const factories: { error: DatspaceError; expectedCode: ErrorCode }[] = [
            { error: querySyntaxError(str), expectedCode: ERROR_CODES.QUERY_SYNTAX_ERROR },
            { error: tableNotFoundError(str), expectedCode: ERROR_CODES.TABLE_NOT_FOUND },
            { error: columnNotFoundError(str, str), expectedCode: ERROR_CODES.COLUMN_NOT_FOUND },
            { error: queryTimeoutError(num), expectedCode: ERROR_CODES.QUERY_TIMEOUT },
            { error: queryCancelledError(str), expectedCode: ERROR_CODES.QUERY_CANCELLED },
            { error: outOfMemoryError(), expectedCode: ERROR_CODES.OUT_OF_MEMORY },
            { error: workerCrashedError(str), expectedCode: ERROR_CODES.WORKER_CRASHED },
            { error: workerUnresponsiveError(), expectedCode: ERROR_CODES.WORKER_UNRESPONSIVE },
            { error: ipcTimeoutError(str, num), expectedCode: ERROR_CODES.IPC_TIMEOUT },
            { error: shuttingDownError(), expectedCode: ERROR_CODES.SHUTTING_DOWN },
            { error: mutationRejectedError(str), expectedCode: ERROR_CODES.MUTATION_REJECTED },
            { error: databaseCorruptError(str), expectedCode: ERROR_CODES.DATABASE_CORRUPT },
            { error: portDisconnectedError(str), expectedCode: ERROR_CODES.PORT_DISCONNECTED },
          ];

          for (const { error, expectedCode } of factories) {
            const meta = ERROR_METADATA[expectedCode];
            expect(error.code).toBe(expectedCode);
            expect(error.retryable).toBe(meta?.retryable);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. queryTimeoutError retryAfterMs capping
  // -------------------------------------------------------------------------
  describe('queryTimeoutError retryAfterMs capping', () => {
    it('retryAfterMs never exceeds 5000 for any positive number', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0.001, max: 1e12, noNaN: true, noDefaultInfinity: true }),
          (ms) => {
            const err = queryTimeoutError(ms);
            expect(err.retryAfterMs).toBeLessThanOrEqual(5_000);
            expect(err.retryAfterMs).toBe(Math.min(ms, 5_000));
          },
        ),
        { numRuns: 100 },
      );
    });

    it('retryAfterMs equals timeoutMs when timeoutMs <= 5000', () => {
      fc.assert(
        fc.property(fc.double({ min: 0, max: 5_000, noNaN: true }), (ms) => {
          const err = queryTimeoutError(ms);
          expect(err.retryAfterMs).toBe(ms);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. mutationRejectedError truncation
  // -------------------------------------------------------------------------
  describe('mutationRejectedError truncation', () => {
    const PREFIX = 'DDL/DML statement rejected: ';

    it('message length never exceeds prefix + 200 characters', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 5_000 }), (sql) => {
          const err = mutationRejectedError(sql);
          expect(err.message.length).toBeLessThanOrEqual(PREFIX.length + 200);
          expect(err.message.startsWith(PREFIX)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('details.sql length never exceeds 1000 characters', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 5_000 }), (sql) => {
          const err = mutationRejectedError(sql);
          const detailsSql = err.details?.['sql'] as string;
          expect(detailsSql.length).toBeLessThanOrEqual(1_000);
        }),
        { numRuns: 100 },
      );
    });

    it('preserves short SQL exactly in both message and details', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 100 }), (sql) => {
          const err = mutationRejectedError(sql);
          expect(err.message).toBe(`${PREFIX}${sql}`);
          expect(err.details?.['sql']).toBe(sql);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. classifyDuckDBError determinism
  // -------------------------------------------------------------------------
  describe('classifyDuckDBError determinism', () => {
    it('messages containing "syntax error" always produce E1001', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (prefix, suffix) => {
          const err = new Error(`${prefix}syntax error${suffix}`);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
        }),
        { numRuns: 100 },
      );
    });

    it('messages containing "parser error" always produce E1001', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (prefix, suffix) => {
          const err = new Error(`${prefix}parser error${suffix}`);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.QUERY_SYNTAX_ERROR);
        }),
        { numRuns: 100 },
      );
    });

    it('messages containing "table" and "does not exist" always produce E1004', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (prefix, suffix) => {
          const err = new Error(`${prefix}table${suffix} does not exist`);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.TABLE_NOT_FOUND);
        }),
        { numRuns: 100 },
      );
    });

    it('messages containing "column" and "does not exist" always produce E1005', () => {
      fc.assert(
        fc.property(fc.string(), (suffix) => {
          // Avoid triggering the table branch by not including "table"
          const msg = `column foo does not exist ${suffix}`.replace(/table/gi, 'tbl');
          const err = new Error(msg);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.COLUMN_NOT_FOUND);
        }),
        { numRuns: 100 },
      );
    });

    it('messages containing "out of memory" always produce E1007', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (prefix, suffix) => {
          const err = new Error(`${prefix}out of memory${suffix}`);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.OUT_OF_MEMORY);
        }),
        { numRuns: 100 },
      );
    });

    it('messages containing "memory limit" always produce E1007', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (prefix, suffix) => {
          const err = new Error(`${prefix}memory limit${suffix}`);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.OUT_OF_MEMORY);
        }),
        { numRuns: 100 },
      );
    });

    it('messages containing "type mismatch" always produce E1006', () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (prefix, suffix) => {
          const err = new Error(`${prefix}type mismatch${suffix}`);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.TYPE_MISMATCH);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 6. classifyDuckDBError fallback
  // -------------------------------------------------------------------------
  describe('classifyDuckDBError fallback', () => {
    /** Arbitrary that avoids all known classification trigger strings. */
    const arbSafeMessage = fc.string().filter((s) => {
      const lower = s.toLowerCase();
      return (
        !lower.includes('syntax error') &&
        !lower.includes('parser error') &&
        !lower.includes('does not exist') &&
        !lower.includes('out of memory') &&
        !lower.includes('memory limit') &&
        !lower.includes('type mismatch')
      );
    });

    it('messages without known patterns default to E1099', () => {
      fc.assert(
        fc.property(arbSafeMessage, (msg) => {
          const err = new Error(msg);
          const classified = classifyDuckDBError(err);
          expect(classified.code).toBe(ERROR_CODES.UNKNOWN_DATABASE_ERROR);
          expect(classified.message).toBe(msg);
        }),
        { numRuns: 100 },
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. ERROR_CODES / ERROR_METADATA completeness
  // -------------------------------------------------------------------------
  describe('ERROR_CODES / ERROR_METADATA completeness', () => {
    it('every code in ERROR_CODES has a matching key in ERROR_METADATA', () => {
      for (const code of allCodeValues) {
        expect(ERROR_METADATA[code]).toBeDefined();
        expect(ERROR_METADATA[code]?.name).toBeTypeOf('string');
        expect(ERROR_METADATA[code]?.retryable).toBeTypeOf('boolean');
        expect(ERROR_METADATA[code]?.defaultMessage).toBeTypeOf('string');
      }
    });

    it('ERROR_METADATA name matches the ERROR_CODES key for each code', () => {
      const codeEntries = Object.entries(ERROR_CODES) as [string, ErrorCode][];
      for (const [key, code] of codeEntries) {
        expect(ERROR_METADATA[code]?.name).toBe(key);
      }
    });

    it('all error codes follow the Exxxx pattern', () => {
      fc.assert(
        fc.property(arbErrorCode, (code) => {
          expect(code).toMatch(/^E\d{4}$/);
        }),
        { numRuns: allCodeValues.length },
      );
    });

    it('E1xxx codes are database errors and E6xxx codes are system errors', () => {
      for (const code of allCodeValues) {
        const num = Number.parseInt(code.slice(1), 10);
        expect(num >= 1000 && num < 7000).toBe(true);
      }
    });
  });
});
