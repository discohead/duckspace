import type { DataType, Field } from '@uwdata/flechette';
import { tableFromIPC } from '@uwdata/flechette';

/**
 * Converts a flechette {@link DataType} object to a human-readable type name.
 *
 * Flechette types are plain objects with a `typeId` discriminant (not strings),
 * so `String(type)` produces `[object Object]`. This helper maps each typeId
 * to a display name, with refinements for Int (signed + bitWidth) and Float (precision).
 *
 * @param type - A flechette DataType object from `field.type`.
 * @returns A display string like `"Int32"`, `"Utf8"`, `"Float64"`, etc.
 */
function arrowTypeName(type: DataType): string {
  switch (type.typeId) {
    case -1:
      return 'Dictionary';
    case 0:
      return 'None';
    case 1:
      return 'Null';
    case 2: {
      const prefix = type.signed ? 'Int' : 'UInt';
      return `${prefix}${String(type.bitWidth)}`;
    }
    case 3: {
      const floatNames: Record<number, string> = { 0: 'Float16', 1: 'Float32', 2: 'Float64' };
      return floatNames[type.precision] ?? 'Float';
    }
    case 4:
      return 'Binary';
    case 5:
      return 'Utf8';
    case 6:
      return 'Bool';
    case 7:
      return 'Decimal';
    case 8:
      return 'Date';
    case 9:
      return 'Time';
    case 10:
      return 'Timestamp';
    case 11:
      return 'Interval';
    case 12:
      return 'List';
    case 13:
      return 'Struct';
    case 14:
      return 'Union';
    case 15:
      return 'FixedSizeBinary';
    case 16:
      return 'FixedSizeList';
    case 17:
      return 'Map';
    case 18:
      return 'Duration';
    case 19:
      return 'LargeBinary';
    case 20:
      return 'LargeUtf8';
    case 21:
      return 'LargeList';
    case 22:
      return 'RunEndEncoded';
    case 23:
      return 'BinaryView';
    case 24:
      return 'Utf8View';
    case 25:
      return 'ListView';
    case 26:
      return 'LargeListView';
    default:
      return 'Unknown';
  }
}

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
    const columnTypes = table.schema.fields.map((f: Field) => arrowTypeName(f.type));
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
