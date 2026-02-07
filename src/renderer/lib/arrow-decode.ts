import { tableFromIPC } from '@uwdata/flechette';

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

export function decodeArrowBatch(buffer: ArrayBuffer): DecodedBatch {
  const table = tableFromIPC(buffer);

  const columns = table.schema.fields.map((f: any) => f.name);
  const columnTypes = table.schema.fields.map((f: any) => String(f.type));
  const rowCount = table.numRows;

  return {
    columns,
    rowCount,
    byteSize: buffer.byteLength,
    columnTypes,
    getColumn(name: string): unknown[] | null {
      const col = table.getChild(name);
      if (!col) return null;
      return Array.from(col.toArray());
    },
    getCell(rowIndex: number, colIndex: number): unknown {
      const col = table.getChildAt(colIndex);
      if (!col) return null;
      return col.at(rowIndex);
    },
  };
}

/** Merge multiple decoded batches into a combined view */
export function mergeBatches(batches: DecodedBatch[]): DecodedBatch | null {
  if (batches.length === 0) return null;
  if (batches.length === 1) return batches[0];

  const columns = batches[0].columns;
  const columnTypes = batches[0].columnTypes;
  const totalRows = batches.reduce((sum, b) => sum + b.rowCount, 0);
  const totalBytes = batches.reduce((sum, b) => sum + b.byteSize, 0);

  return {
    columns,
    columnTypes,
    rowCount: totalRows,
    byteSize: totalBytes,
    getColumn(name: string): unknown[] | null {
      const arrays = batches.map(b => b.getColumn(name)).filter(Boolean) as unknown[][];
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
