/**
 * Format detection for local data ingestion.
 *
 * Detects {@link DataSourceFormat} from file extension with magic byte validation
 * for ambiguous cases (Parquet, Arrow IPC, XLSX). Also provides table name
 * generation from file paths with collision avoidance.
 */

import { open, stat } from 'node:fs/promises';
import path from 'node:path';

import { fileNotFoundError, unsupportedFormatError } from '@shared/errors';
import type { DataSourceFormat } from '@shared/types';

// ---------------------------------------------------------------------------
// Extension → Format Mapping
// ---------------------------------------------------------------------------

/**
 * Map of lowercase file extensions (without leading dot) to their corresponding
 * {@link DataSourceFormat} values.
 */
const EXTENSION_FORMAT_MAP: ReadonlyMap<string, DataSourceFormat> = new Map<
  string,
  DataSourceFormat
>([
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['parquet', 'parquet'],
  ['json', 'json'],
  ['jsonl', 'jsonl'],
  ['ndjson', 'jsonl'],
  ['xlsx', 'xlsx'],
  ['xls', 'xlsx'],
  ['arrow', 'arrow_ipc'],
  ['ipc', 'arrow_ipc'],
  ['feather', 'arrow_ipc'],
]);

// ---------------------------------------------------------------------------
// Magic Byte Signatures
// ---------------------------------------------------------------------------

/** Parquet magic bytes: `PAR1` at file offset 0 */
const PARQUET_MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x31]);

/** Arrow IPC magic bytes: `ARROW1` at file offset 0 */
const ARROW_IPC_MAGIC = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]);

/** XLSX (PK zip) magic bytes at file offset 0 */
const XLSX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/**
 * Formats that require magic byte validation to confirm the extension-based
 * detection is correct.
 */
const MAGIC_BYTE_FORMATS: ReadonlyMap<DataSourceFormat, Uint8Array> = new Map<
  DataSourceFormat,
  Uint8Array
>([
  ['parquet', PARQUET_MAGIC],
  ['arrow_ipc', ARROW_IPC_MAGIC],
  ['xlsx', XLSX_MAGIC],
]);

/** Number of bytes to read for magic byte validation (covers longest signature). */
const MAGIC_BYTE_READ_SIZE = 8;

// ---------------------------------------------------------------------------
// Magic Byte Helpers
// ---------------------------------------------------------------------------

/**
 * Compare a file header buffer against an expected magic byte sequence.
 *
 * @param header - The bytes read from the beginning of the file.
 * @param expected - The expected magic byte signature.
 * @returns `true` if the header starts with the expected bytes.
 */
function matchesMagicBytes(header: Uint8Array, expected: Uint8Array): boolean {
  if (header.length < expected.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    if (header[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Read the first {@link MAGIC_BYTE_READ_SIZE} bytes from a file.
 *
 * @param filePath - Absolute path to the file.
 * @returns The first bytes of the file as a `Uint8Array`.
 */
async function readMagicBytes(filePath: string): Promise<Uint8Array> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = new Uint8Array(MAGIC_BYTE_READ_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, MAGIC_BYTE_READ_SIZE, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Attempt to detect format from magic bytes alone, without relying on extension.
 *
 * @param header - The first bytes of the file.
 * @returns The detected format, or `undefined` if no magic signature matches.
 */
function detectFormatFromMagicBytes(header: Uint8Array): DataSourceFormat | undefined {
  for (const [format, magic] of MAGIC_BYTE_FORMATS) {
    if (matchesMagicBytes(header, magic)) {
      return format;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the {@link DataSourceFormat} of a file by its extension, with magic byte
 * validation for ambiguous binary formats (Parquet, Arrow IPC, XLSX).
 *
 * For text-based formats (CSV, TSV, JSON, JSONL), the extension alone is
 * authoritative. For binary formats, the first 8 bytes are checked against
 * known magic byte signatures to confirm the extension-based detection.
 *
 * If magic bytes do not match the extension-suggested format, the magic byte
 * detection result takes precedence when available. Otherwise the extension-based
 * result is returned.
 *
 * @param filePath - Absolute path to the file to detect.
 * @returns The detected data source format.
 * @throws DuckspaceError E2001 if the file does not exist.
 * @throws DuckspaceError E2002 if the file extension is not recognized.
 */
export async function detectFormat(filePath: string): Promise<DataSourceFormat> {
  // Verify the file exists
  try {
    await stat(filePath);
  } catch {
    throw fileNotFoundError(filePath);
  }

  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  const formatFromExtension = EXTENSION_FORMAT_MAP.get(ext);

  if (formatFromExtension === undefined) {
    throw unsupportedFormatError(filePath, ext === '' ? '(none)' : `.${ext}`);
  }

  // For formats with known magic bytes, validate the file header
  const expectedMagic = MAGIC_BYTE_FORMATS.get(formatFromExtension);
  if (expectedMagic !== undefined) {
    const header = await readMagicBytes(filePath);
    if (matchesMagicBytes(header, expectedMagic)) {
      return formatFromExtension;
    }

    // Magic bytes don't match extension — try all known signatures
    const magicDetected = detectFormatFromMagicBytes(header);
    if (magicDetected !== undefined) {
      return magicDetected;
    }

    // Fall back to extension-based detection even though magic didn't match.
    // The file may be truncated or have non-standard headers.
    console.warn(
      `[FormatDetector] Magic bytes for "${filePath}" do not match expected format "${formatFromExtension}"; falling back to extension-based detection`,
    );
    return formatFromExtension;
  }

  return formatFromExtension;
}

/**
 * Generate a DuckDB-safe table name from a file path.
 *
 * Takes the filename without extension, lowercases it, and replaces
 * non-alphanumeric characters (except underscores) with underscores.
 * Leading digits are prefixed with an underscore. Empty results default
 * to `"table"`.
 *
 * If the generated name conflicts with `existingNames`, a numeric suffix
 * (`_2`, `_3`, ...) is appended until a unique name is found.
 *
 * @param filePath - Absolute or relative path to the file.
 * @param existingNames - Optional set of table names already in use.
 * @returns A unique, DuckDB-safe table name.
 */
export function generateTableName(filePath: string, existingNames?: ReadonlySet<string>): string {
  const basename = path.basename(filePath, path.extname(filePath));
  let name = basename.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  // Collapse consecutive underscores
  name = name.replace(/_+/g, '_');

  // Strip leading/trailing underscores
  name = name.replace(/^_+|_+$/g, '');

  // Prefix with underscore if starts with a digit
  if (/^\d/.test(name)) {
    name = `_${name}`;
  }

  // Fall back to generic name if empty
  if (name === '') {
    name = 'table';
  }

  if (!existingNames?.has(name)) {
    return name;
  }

  // Resolve collision with numeric suffix
  let counter = 2;
  while (existingNames.has(`${name}_${String(counter)}`)) {
    counter++;
  }

  return `${name}_${String(counter)}`;
}
