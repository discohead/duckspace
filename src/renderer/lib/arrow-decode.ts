import type { Field } from '@uwdata/flechette';
import { tableFromIPC } from '@uwdata/flechette';

/**
 * A decoded Arrow IPC batch with column metadata and cell-level accessors.
 * Wraps the flechette table for convenient row/column access.
 */
export interface DecodedBatch {
  /** Column names in order */
  columns: string[];
  /** Number of rows */
  rowCount: number;
  /** Total byte size of the original IPC buffer */
  byteSize: number;
  /** Get all values for a column by name */
  getColumn(name: string): unknown[] | null;
  /** Get a single cell value */
  getCell(rowIndex: number, colIndex: number): unknown;
  /** Get column types as strings */
  columnTypes: string[];
}

/**
 * Decodes an Arrow IPC buffer into a {@link DecodedBatch} with column names, types, and cell accessors.
 *
 * @param buffer - The raw Arrow IPC ArrayBuffer received from the data plane.
 * @returns A decoded batch object with metadata and data access methods, or `null` if decoding fails.
 */
export function decodeArrowBatch(buffer: ArrayBuffer): DecodedBatch | null {
  try {
    const table = tableFromIPC(buffer);

    const columns = table.schema.fields.map((f: Field) => f.name);
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    const columnTypes = table.schema.fields.map((f: Field) => String(f.type));
    const rowCount = table.numRows;

    return {
      columns,
      rowCount,
      byteSize: buffer.byteLength,
      columnTypes,
      getColumn(name: string): unknown[] | null {
        const col = table.getChild(name);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- getChild returns null for missing columns
        if (!col) return null;
        return Array.from(col.toArray()) as unknown[];
      },
      getCell(rowIndex: number, colIndex: number): unknown {
        const col = table.getChildAt(colIndex);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- getChildAt returns null for out-of-bounds
        if (!col) return null;
        return col.at(rowIndex) as unknown;
      },
    };
  } catch (err) {
    console.error('Failed to decode Arrow IPC buffer:', err);
    return null;
  }
}

/**
 * Merges multiple decoded batches into a single combined view.
 * Cell access delegates to the appropriate underlying batch using cumulative row offsets.
 *
 * @param batches - An array of decoded batches to merge.
 * @returns A merged batch, or `null` if the input array is empty.
 */
export function mergeBatches(batches: DecodedBatch[]): DecodedBatch | null {
  if (batches.length === 0) return null;

  const first = batches[0];
  if (!first) return null;
  if (batches.length === 1) return first;

  const columns = first.columns;
  const columnTypes = first.columnTypes;
  const totalRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
  const totalBytes = batches.reduce((sum, b) => sum + b.byteSize, 0);

  return {
    columns,
    columnTypes,
    rowCount: totalRows,
    byteSize: totalBytes,
    getColumn(name: string): unknown[] | null {
      const arrays = batches.map((b) => b.getColumn(name)).filter(Boolean) as unknown[][];
      if (arrays.length === 0) return null;
      return arrays.flat();
    },
    getCell(rowIndex: number, colIndex: number): unknown {
      let offset = 0;
      for (const batch of batches) {
        if (rowIndex < offset + batch.rowCount) {
          return batch.getCell(rowIndex - offset, colIndex);
        }
        offset += batch.rowCount;
      }
      return null;
    },
  };
}
