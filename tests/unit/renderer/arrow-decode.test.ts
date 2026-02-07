import { describe, expect, it, vi } from 'vitest';

// Mock @uwdata/flechette
vi.mock('@uwdata/flechette', () => ({
  tableFromIPC: vi.fn((_buffer: ArrayBuffer) => {
    // Return a mock table with two columns
    const columns = {
      id: { toArray: () => [1, 2, 3], at: (i: number) => [1, 2, 3][i] },
      name: { toArray: () => ['a', 'b', 'c'], at: (i: number) => ['a', 'b', 'c'][i] },
    };
    const fields = [
      { name: 'id', type: 'Int32' },
      { name: 'name', type: 'Utf8' },
    ];
    return {
      schema: { fields },
      numRows: 3,
      getChild: (name: string) => columns[name as keyof typeof columns] || null,
      getChildAt: (index: number) => {
        const cols = [columns.id, columns.name];
        return cols[index] || null;
      },
    };
  }),
}));

import { type DecodedBatch, decodeArrowBatch, mergeBatches } from '@renderer/lib/arrow-decode';

describe('decodeArrowBatch', () => {
  it('decodes buffer into batch with correct metadata', () => {
    const buffer = new ArrayBuffer(256);
    const batch = decodeArrowBatch(buffer);

    expect(batch).not.toBeNull();
    expect(batch!.columns).toEqual(['id', 'name']);
    expect(batch!.columnTypes).toEqual(['Int32', 'Utf8']);
    expect(batch!.rowCount).toBe(3);
    expect(batch!.byteSize).toBe(256);
  });

  it('getColumn returns values for existing column', () => {
    const batch = decodeArrowBatch(new ArrayBuffer(100));
    expect(batch).not.toBeNull();
    expect(batch!.getColumn('id')).toEqual([1, 2, 3]);
    expect(batch!.getColumn('name')).toEqual(['a', 'b', 'c']);
  });

  it('getColumn returns null for missing column', () => {
    const batch = decodeArrowBatch(new ArrayBuffer(100));
    expect(batch).not.toBeNull();
    expect(batch!.getColumn('nonexistent')).toBeNull();
  });

  it('getCell returns value at row/col', () => {
    const batch = decodeArrowBatch(new ArrayBuffer(100));
    expect(batch).not.toBeNull();
    expect(batch!.getCell(0, 0)).toBe(1);
    expect(batch!.getCell(2, 1)).toBe('c');
  });

  it('getCell returns null for out-of-bounds column', () => {
    const batch = decodeArrowBatch(new ArrayBuffer(100));
    expect(batch).not.toBeNull();
    expect(batch!.getCell(0, 99)).toBeNull();
  });

  // I10: returns null on corrupt buffer
  it('returns null when tableFromIPC throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tableFromIPC } = await import('@uwdata/flechette');
    vi.mocked(tableFromIPC).mockImplementationOnce(() => {
      throw new Error('Invalid Arrow IPC stream');
    });

    const result = decodeArrowBatch(new ArrayBuffer(4));
    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to decode Arrow IPC buffer:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});

describe('mergeBatches', () => {
  function makeBatch(overrides: Partial<DecodedBatch> = {}): DecodedBatch {
    return {
      columns: ['id', 'name'],
      columnTypes: ['Int32', 'Utf8'],
      rowCount: 2,
      byteSize: 100,
      getColumn: vi.fn((name: string) => {
        if (name === 'id') return [1, 2];
        if (name === 'name') return ['a', 'b'];
        return null;
      }),
      getCell: vi.fn((row: number, col: number) => {
        const data = [
          [1, 'a'],
          [2, 'b'],
        ];
        return data[row]?.[col] ?? null;
      }),
      ...overrides,
    };
  }

  it('returns null for empty array', () => {
    expect(mergeBatches([])).toBeNull();
  });

  it('returns single batch unchanged', () => {
    const batch = makeBatch();
    expect(mergeBatches([batch])).toBe(batch);
  });

  it('combines row counts and byte sizes', () => {
    const b1 = makeBatch({ rowCount: 3, byteSize: 100 });
    const b2 = makeBatch({ rowCount: 5, byteSize: 200 });

    const merged = mergeBatches([b1, b2])!;
    expect(merged.rowCount).toBe(8);
    expect(merged.byteSize).toBe(300);
  });

  it('preserves column info from first batch', () => {
    const b1 = makeBatch();
    const b2 = makeBatch();

    const merged = mergeBatches([b1, b2])!;
    expect(merged.columns).toEqual(['id', 'name']);
    expect(merged.columnTypes).toEqual(['Int32', 'Utf8']);
  });

  it('getColumn concatenates values from all batches', () => {
    const b1 = makeBatch({
      rowCount: 2,
      getColumn: (name: string) => (name === 'id' ? [1, 2] : null),
    });
    const b2 = makeBatch({
      rowCount: 2,
      getColumn: (name: string) => (name === 'id' ? [3, 4] : null),
    });

    const merged = mergeBatches([b1, b2])!;
    expect(merged.getColumn('id')).toEqual([1, 2, 3, 4]);
  });

  it('getColumn returns null when no batch has the column', () => {
    const b1 = makeBatch({ getColumn: () => null });
    const b2 = makeBatch({ getColumn: () => null });

    const merged = mergeBatches([b1, b2])!;
    expect(merged.getColumn('missing')).toBeNull();
  });

  it('getCell delegates to correct batch based on row offset', () => {
    const b1 = makeBatch({
      rowCount: 2,
      getCell: (row: number, col: number) => `b1-r${row}-c${col}`,
    });
    const b2 = makeBatch({
      rowCount: 3,
      getCell: (row: number, col: number) => `b2-r${row}-c${col}`,
    });

    const merged = mergeBatches([b1, b2])!;

    // Rows 0-1 from batch1
    expect(merged.getCell(0, 0)).toBe('b1-r0-c0');
    expect(merged.getCell(1, 0)).toBe('b1-r1-c0');

    // Rows 2-4 from batch2 (offset by 2)
    expect(merged.getCell(2, 0)).toBe('b2-r0-c0');
    expect(merged.getCell(4, 1)).toBe('b2-r2-c1');
  });

  it('getCell returns null for row beyond all batches', () => {
    const b1 = makeBatch({ rowCount: 2 });

    mergeBatches([b1]);
    // Single batch, so mergeBatches returns it directly
    // Test with multiple batches
    const b2 = makeBatch({ rowCount: 1 });
    const merged2 = mergeBatches([b1, b2])!;
    expect(merged2.getCell(99, 0)).toBeNull();
  });
});
