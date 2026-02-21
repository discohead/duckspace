import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockStat = vi.fn();
const mockOpen = vi.fn();

vi.mock('node:fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  open: (...args: unknown[]) => mockOpen(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { detectFormat, generateTableName } from '@main/ingestion/format-detector';
import { ERROR_CODES } from '@shared/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parquet magic bytes: PAR1 */
const PARQUET_MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x31]);

/** Arrow IPC magic bytes: ARROW1 */
const ARROW_MAGIC = new Uint8Array([0x41, 0x52, 0x52, 0x4f, 0x57, 0x31]);

/** XLSX (PK zip) magic bytes */
const XLSX_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/**
 * Create a mock file handle that returns the given header bytes on read().
 */
function mockFileHandle(headerBytes: Uint8Array): {
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn((buffer: Uint8Array, _offset: number, length: number, _position: number) => {
      const bytesToCopy = Math.min(length, headerBytes.length);
      buffer.set(headerBytes.subarray(0, bytesToCopy));
      return Promise.resolve({ bytesRead: bytesToCopy });
    }),
    close: vi.fn(() => Promise.resolve()),
  };
}

/** Make stat resolve (file exists). */
function fileExists(): void {
  mockStat.mockResolvedValue({ isFile: () => true });
}

/** Make stat reject (file does not exist). */
function fileDoesNotExist(): void {
  mockStat.mockRejectedValue(new Error('ENOENT'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('format-detector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // detectFormat
  // -----------------------------------------------------------------------

  describe('detectFormat', () => {
    // -- Text-based formats (no magic byte check) -------------------------

    it.each([
      ['/data/sales.csv', 'csv'],
      ['/data/sales.tsv', 'tsv'],
      ['/data/sales.json', 'json'],
      ['/data/sales.jsonl', 'jsonl'],
      ['/data/sales.ndjson', 'jsonl'],
    ] as const)('detects %s as %s', async (filePath, expected) => {
      fileExists();
      const format = await detectFormat(filePath);
      expect(format).toBe(expected);
    });

    // -- Case insensitivity -----------------------------------------------

    it.each([
      ['/data/sales.CSV', 'csv'],
      ['/data/sales.Parquet', 'parquet'],
      ['/data/sales.JSON', 'json'],
      ['/data/sales.XLSX', 'xlsx'],
      ['/data/sales.XLS', 'xlsx'],
      ['/data/sales.TSV', 'tsv'],
      ['/data/sales.ARROW', 'arrow_ipc'],
      ['/data/sales.IPC', 'arrow_ipc'],
      ['/data/sales.Feather', 'arrow_ipc'],
    ] as const)('is case-insensitive: %s => %s', async (filePath, expected) => {
      fileExists();
      // Binary formats need magic bytes to pass
      if (expected === 'parquet' || expected === 'arrow_ipc' || expected === 'xlsx') {
        const magicMap: Record<string, Uint8Array> = {
          parquet: PARQUET_MAGIC,
          arrow_ipc: ARROW_MAGIC,
          xlsx: XLSX_MAGIC,
        };
        const magic = magicMap[expected];
        if (magic !== undefined) {
          const handle = mockFileHandle(magic);
          mockOpen.mockResolvedValue(handle);
        }
      }
      const format = await detectFormat(filePath);
      expect(format).toBe(expected);
    });

    // -- Binary formats with matching magic bytes -------------------------

    it('detects .parquet with correct PAR1 magic bytes', async () => {
      fileExists();
      const handle = mockFileHandle(PARQUET_MAGIC);
      mockOpen.mockResolvedValue(handle);

      const format = await detectFormat('/data/sales.parquet');
      expect(format).toBe('parquet');
      expect(handle.close).toHaveBeenCalled();
    });

    it('detects .xlsx with correct PK zip magic bytes', async () => {
      fileExists();
      const handle = mockFileHandle(XLSX_MAGIC);
      mockOpen.mockResolvedValue(handle);

      const format = await detectFormat('/data/sales.xlsx');
      expect(format).toBe('xlsx');
    });

    it('detects .xls as xlsx with correct PK zip magic bytes', async () => {
      fileExists();
      const handle = mockFileHandle(XLSX_MAGIC);
      mockOpen.mockResolvedValue(handle);

      const format = await detectFormat('/data/sales.xls');
      expect(format).toBe('xlsx');
    });

    it.each([
      ['/data/data.arrow', 'arrow_ipc'],
      ['/data/data.ipc', 'arrow_ipc'],
      ['/data/data.feather', 'arrow_ipc'],
    ] as const)('detects %s as %s with ARROW1 magic bytes', async (filePath, expected) => {
      fileExists();
      const handle = mockFileHandle(ARROW_MAGIC);
      mockOpen.mockResolvedValue(handle);

      const format = await detectFormat(filePath);
      expect(format).toBe(expected);
    });

    // -- Magic byte mismatch: falls back to extension or detects true format

    it('returns magic-detected format when .parquet file has XLSX magic bytes', async () => {
      fileExists();
      // File is named .parquet but has PK zip (xlsx) magic
      const handle = mockFileHandle(XLSX_MAGIC);
      mockOpen.mockResolvedValue(handle);

      const format = await detectFormat('/data/sales.parquet');
      // Magic bytes match xlsx, so it returns xlsx instead of parquet
      expect(format).toBe('xlsx');
    });

    it('falls back to extension when magic bytes match no known format', async () => {
      fileExists();
      // Random bytes that don't match any known magic signature
      const randomBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      const handle = mockFileHandle(randomBytes);
      mockOpen.mockResolvedValue(handle);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const format = await detectFormat('/data/sales.parquet');
      expect(format).toBe('parquet');
      // H-2: should log a warning about magic byte mismatch
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Magic bytes for'));
      warnSpy.mockRestore();
    });

    // -- Error cases -------------------------------------------------------

    it('throws E2002 for unsupported extension', async () => {
      fileExists();

      await expect(detectFormat('/data/sales.xyz')).rejects.toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_FORMAT,
      });
    });

    it('throws E2002 for file with no extension', async () => {
      fileExists();

      await expect(detectFormat('/data/Makefile')).rejects.toMatchObject({
        code: ERROR_CODES.UNSUPPORTED_FORMAT,
      });
    });

    it('throws E2001 when file does not exist', async () => {
      fileDoesNotExist();

      await expect(detectFormat('/data/missing.csv')).rejects.toMatchObject({
        code: ERROR_CODES.FILE_NOT_FOUND,
      });
    });
  });

  // -----------------------------------------------------------------------
  // generateTableName
  // -----------------------------------------------------------------------

  describe('generateTableName', () => {
    it('generates a simple lowercase name from a filename', () => {
      expect(generateTableName('/data/Sales.csv')).toBe('sales');
    });

    it('replaces special characters with underscores', () => {
      expect(generateTableName('/data/my-sales data (2024).csv')).toBe('my_sales_data_2024');
    });

    it('collapses consecutive underscores', () => {
      expect(generateTableName('/data/my---data.csv')).toBe('my_data');
    });

    it('strips leading and trailing underscores', () => {
      expect(generateTableName('/data/___data___.csv')).toBe('data');
    });

    it('prefixes with underscore when name starts with a digit', () => {
      expect(generateTableName('/data/2024_sales.csv')).toBe('_2024_sales');
    });

    it('defaults to "table" when name is empty after normalization', () => {
      expect(generateTableName('/data/---.csv')).toBe('table');
    });

    it('defaults to "table" for purely special character filenames', () => {
      expect(generateTableName('/data/!!!.csv')).toBe('table');
    });

    it('returns the name directly when no collision', () => {
      const existing = new Set(['other_table']);
      expect(generateTableName('/data/sales.csv', existing)).toBe('sales');
    });

    it('appends _2 on first collision', () => {
      const existing = new Set(['sales']);
      expect(generateTableName('/data/sales.csv', existing)).toBe('sales_2');
    });

    it('appends _3 when _2 is also taken', () => {
      const existing = new Set(['sales', 'sales_2']);
      expect(generateTableName('/data/sales.csv', existing)).toBe('sales_3');
    });

    it('skips multiple collisions to find the first available suffix', () => {
      const existing = new Set(['sales', 'sales_2', 'sales_3', 'sales_4']);
      expect(generateTableName('/data/sales.csv', existing)).toBe('sales_5');
    });

    it('handles files with multiple dots in the name', () => {
      expect(generateTableName('/data/my.data.file.csv')).toBe('my_data_file');
    });

    it('strips the extension from the basename', () => {
      // Extension should not appear in the table name
      const name = generateTableName('/data/report.parquet');
      expect(name).not.toContain('parquet');
      expect(name).toBe('report');
    });
  });
});
