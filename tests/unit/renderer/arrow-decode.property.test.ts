import type { DecodedBatch } from '@renderer/lib/arrow-decode';
import { mergeBatches } from '@renderer/lib/arrow-decode';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

/**
 * Creates a mock DecodedBatch from generated data for property-based testing.
 * Does NOT use real Arrow IPC buffers — purely synthetic data.
 */
function createMockBatch(
  rowCount: number,
  byteSize: number,
  columns: string[],
  data: unknown[][],
): DecodedBatch {
  return {
    columns,
    columnTypes: columns.map(() => 'Int32'),
    rowCount,
    byteSize,
    getColumn(name: string): unknown[] | null {
      const idx = columns.indexOf(name);
      if (idx === -1) return null;
      return data[idx] ?? null;
    },
    getCell(rowIndex: number, colIndex: number): unknown {
      if (colIndex < 0 || colIndex >= columns.length) return null;
      const col = data[colIndex];
      if (!col || rowIndex < 0 || rowIndex >= rowCount) return null;
      return col[rowIndex] ?? null;
    },
  };
}

/** Fixed columns used across all generated batches so they share the same schema. */
const COLUMNS = ['col_a', 'col_b', 'col_c'];

/**
 * Arbitrary that produces a single mock DecodedBatch with random rowCount, byteSize,
 * and integer cell data matching the fixed column schema.
 */
const batchArbitrary: fc.Arbitrary<DecodedBatch> = fc
  .integer({ min: 1, max: 20 })
  .chain((rowCount) =>
    fc
      .tuple(
        fc.integer({ min: 1, max: 5000 }),
        ...COLUMNS.map(() => fc.array(fc.integer(), { minLength: rowCount, maxLength: rowCount })),
      )
      .map(([byteSize, ...columnData]) => createMockBatch(rowCount, byteSize, COLUMNS, columnData)),
  );

describe('mergeBatches property tests', () => {
  it('returns null for empty input', () => {
    fc.assert(
      fc.property(fc.constant([] as DecodedBatch[]), (batches) => {
        expect(mergeBatches(batches)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('single batch identity — returns the same object reference', () => {
    fc.assert(
      fc.property(batchArbitrary, (batch) => {
        const result = mergeBatches([batch]);
        expect(result).toBe(batch);
      }),
      { numRuns: 100 },
    );
  });

  it('row count is additive across batches', () => {
    fc.assert(
      fc.property(fc.array(batchArbitrary, { minLength: 2, maxLength: 5 }), (batches) => {
        const merged = mergeBatches(batches)!;
        const expectedRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
        expect(merged.rowCount).toBe(expectedRows);
      }),
      { numRuns: 100 },
    );
  });

  it('byte size is additive across batches', () => {
    fc.assert(
      fc.property(fc.array(batchArbitrary, { minLength: 2, maxLength: 5 }), (batches) => {
        const merged = mergeBatches(batches)!;
        const expectedBytes = batches.reduce((sum, b) => sum + b.byteSize, 0);
        expect(merged.byteSize).toBe(expectedBytes);
      }),
      { numRuns: 100 },
    );
  });

  it('getCell delegates to the correct sub-batch for any valid global row index', () => {
    fc.assert(
      fc.property(
        fc.array(batchArbitrary, { minLength: 2, maxLength: 5 }).chain((batches) => {
          const totalRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
          return fc.tuple(
            fc.constant(batches),
            fc.nat({ max: totalRows - 1 }),
            fc.nat({ max: COLUMNS.length - 1 }),
          );
        }),
        ([batches, globalRow, colIndex]) => {
          const merged = mergeBatches(batches)!;
          const mergedValue = merged.getCell(globalRow, colIndex);

          // Manually find the correct sub-batch and local row
          let offset = 0;
          let expectedValue: unknown = null;
          for (const batch of batches) {
            if (globalRow < offset + batch.rowCount) {
              expectedValue = batch.getCell(globalRow - offset, colIndex);
              break;
            }
            offset += batch.rowCount;
          }

          expect(mergedValue).toBe(expectedValue);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getCell returns null for one-past-the-end row index', () => {
    fc.assert(
      fc.property(fc.array(batchArbitrary, { minLength: 2, maxLength: 5 }), (batches) => {
        const merged = mergeBatches(batches)!;
        const totalRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
        expect(merged.getCell(totalRows, 0)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('column names are always taken from the first batch', () => {
    fc.assert(
      fc.property(fc.array(batchArbitrary, { minLength: 2, maxLength: 5 }), (batches) => {
        const merged = mergeBatches(batches)!;
        const first = batches[0]!;
        expect(merged.columns).toBe(first.columns);
      }),
      { numRuns: 100 },
    );
  });
});
