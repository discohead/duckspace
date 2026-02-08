import {
  ArrowBatchMessageSchema,
  DataPlaneCancelMessageSchema,
  DataPlaneMessageSchema,
} from '@shared/schemas/data-plane-schemas';
import { QueryExecuteRequestSchema } from '@shared/schemas/ipc-schemas';
import { WorkerHealthResponseSchema } from '@shared/schemas/worker-schemas';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('schema validation properties', () => {
  describe('IPC schemas', () => {
    it('rejects empty SQL strings', () => {
      fc.assert(
        fc.property(fc.constant(''), (sql) => {
          const result = QueryExecuteRequestSchema.safeParse({ sql });
          expect(result.success).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('accepts any non-empty SQL string', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), (sql) => {
          const result = QueryExecuteRequestSchema.safeParse({ sql });
          expect(result.success).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('rejects payloads with extra keys in strict mode', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string().filter((s) => s !== 'sql' && s !== 'params' && s.length > 0),
          fc.anything(),
          (sql, extraKey, extraValue) => {
            const result = QueryExecuteRequestSchema.safeParse({
              sql,
              [extraKey]: extraValue,
            });
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('data plane schemas', () => {
    it('rejects negative values for ArrowBatchMessage numeric fields', () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.integer({ min: -1_000_000, max: -1 }),
          fc.oneof(
            fc.constant('index' as const),
            fc.constant('rowCount' as const),
            fc.constant('byteSize' as const),
          ),
          (queryId, negativeValue, field) => {
            const base = {
              type: 'arrow-batch' as const,
              queryId,
              index: 0,
              rowCount: 0,
              byteSize: 0,
            };
            const result = ArrowBatchMessageSchema.safeParse({
              ...base,
              [field]: negativeValue,
            });
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('routes discriminated union correctly for all 5 message types', () => {
      const arrowBatchArb = fc.record({
        type: fc.constant('arrow-batch' as const),
        queryId: fc.string(),
        index: fc.nat(),
        rowCount: fc.nat(),
        byteSize: fc.nat(),
      });

      const streamEndArb = fc.record({
        type: fc.constant('arrow-end' as const),
        queryId: fc.string(),
        totalBatches: fc.nat(),
        totalRows: fc.nat(),
        totalBytes: fc.nat(),
        durationMs: fc.double({ min: 0, max: 1e9, noNaN: true }),
      });

      const dataPlaneErrorArb = fc.record({
        type: fc.constant('arrow-error' as const),
        queryId: fc.string(),
        code: fc.string(),
        message: fc.string(),
        batchesSent: fc.nat(),
      });

      const batchAckArb = fc.record({
        type: fc.constant('ack' as const),
        queryId: fc.string(),
        index: fc.nat(),
      });

      const cancelArb = fc.record({
        type: fc.constant('cancel' as const),
        queryId: fc.string(),
      });

      fc.assert(
        fc.property(
          fc.oneof(arrowBatchArb, streamEndArb, dataPlaneErrorArb, batchAckArb, cancelArb),
          (msg) => {
            const result = DataPlaneMessageSchema.safeParse(msg);
            expect(result.success).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('rejects arbitrary strings as cancel reason', () => {
      const validReasons = ['user_cancelled', 'component_unmounted', 'timeout', 'superseded'];
      fc.assert(
        fc.property(
          fc.string(),
          fc.string().filter((s) => !validReasons.includes(s)),
          (queryId, reason) => {
            const result = DataPlaneCancelMessageSchema.safeParse({
              type: 'cancel',
              queryId,
              reason,
            });
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('worker schemas', () => {
    it('rejects arbitrary strings as health status', () => {
      const validStatuses = ['healthy', 'degraded', 'failed'];
      fc.assert(
        fc.property(
          fc.string().filter((s) => !validStatuses.includes(s)),
          (status) => {
            const result = WorkerHealthResponseSchema.safeParse({
              type: 'health_check_result',
              status,
              tables: 0,
              memoryUsedMB: 0,
              activeQueries: 0,
            });
            expect(result.success).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
