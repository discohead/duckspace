import {
  ColumnSchemaExtendedSchema,
  ColumnStatisticsSchema,
  DataSourceSchema,
  GetColumnStatsRequestSchema,
  GetSourcesRequestSchema,
  RemoveSourceRequestSchema,
  TopValueSchema,
  UpdateSourceRequestSchema,
} from '@shared/schemas/catalog-schemas';
import { describe, expect, it } from 'vitest';

describe('catalog-schemas', () => {
  describe('TopValueSchema', () => {
    it('accepts valid top value', () => {
      const result = TopValueSchema.safeParse({
        value: 'foo',
        count: 42,
        percentage: 12.5,
      });
      expect(result.success).toBe(true);
    });

    it('rejects negative count', () => {
      const result = TopValueSchema.safeParse({
        value: 'foo',
        count: -1,
        percentage: 12.5,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative percentage', () => {
      const result = TopValueSchema.safeParse({
        value: 'foo',
        count: 42,
        percentage: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      const result = TopValueSchema.safeParse({
        value: 'foo',
        count: 42,
        percentage: 12.5,
        extra: 'nope',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ColumnStatisticsSchema', () => {
    const validStat = {
      id: 'ds1__col1',
      dataSourceId: 'ds1',
      columnName: 'col1',
      rowCount: 1000,
      nullCount: 50,
      nullPercentage: 5.0,
      distinctCount: 200,
      computedAt: '2024-01-01T00:00:00Z',
    };

    it('accepts minimal valid input', () => {
      const result = ColumnStatisticsSchema.safeParse(validStat);
      expect(result.success).toBe(true);
    });

    it('accepts with all optional numeric fields', () => {
      const result = ColumnStatisticsSchema.safeParse({
        ...validStat,
        min: '0',
        max: '999',
        mean: 42.5,
        median: 40,
        stddev: 10.2,
        q25: 20,
        q75: 60,
        topValues: [{ value: 'a', count: 10, percentage: 1.0 }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty id', () => {
      const result = ColumnStatisticsSchema.safeParse({ ...validStat, id: '' });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer rowCount', () => {
      const result = ColumnStatisticsSchema.safeParse({ ...validStat, rowCount: 1.5 });
      expect(result.success).toBe(false);
    });

    it('rejects negative nullCount', () => {
      const result = ColumnStatisticsSchema.safeParse({ ...validStat, nullCount: -1 });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      const result = ColumnStatisticsSchema.safeParse({ ...validStat, bonus: true });
      expect(result.success).toBe(false);
    });
  });

  describe('DataSourceSchema', () => {
    const validSource = {
      id: 'ds-1',
      name: 'test.csv',
      filePath: '/data/test.csv',
      format: 'csv' as const,
      status: 'active' as const,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('accepts valid data source', () => {
      const result = DataSourceSchema.safeParse(validSource);
      expect(result.success).toBe(true);
    });

    it('accepts with optional fields', () => {
      const result = DataSourceSchema.safeParse({
        ...validSource,
        duckdbTableName: 'test_csv',
        duckdbViewName: 'v_test_csv',
        rowCount: 1000,
        columnCount: 10,
        fileSizeBytes: 4096,
        fileModifiedAt: '2024-01-01T00:00:00Z',
        watchDirectoryId: 'wd-1',
        sheetName: 'Sheet1',
        errorMessage: 'something failed',
        errorCode: 'E1001',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty name', () => {
      const result = DataSourceSchema.safeParse({ ...validSource, name: '' });
      expect(result.success).toBe(false);
    });

    it('rejects name exceeding 255 chars', () => {
      const result = DataSourceSchema.safeParse({
        ...validSource,
        name: 'a'.repeat(256),
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid format', () => {
      const result = DataSourceSchema.safeParse({ ...validSource, format: 'docx' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid status', () => {
      const result = DataSourceSchema.safeParse({ ...validSource, status: 'unknown' });
      expect(result.success).toBe(false);
    });

    it('accepts all valid formats', () => {
      for (const format of ['csv', 'tsv', 'parquet', 'json', 'jsonl', 'xlsx', 'arrow_ipc']) {
        const result = DataSourceSchema.safeParse({ ...validSource, format });
        expect(result.success).toBe(true);
      }
    });

    it('accepts all valid statuses', () => {
      for (const status of ['importing', 'active', 'stale', 'error', 'removed']) {
        const result = DataSourceSchema.safeParse({ ...validSource, status });
        expect(result.success).toBe(true);
      }
    });

    it('rejects tags exceeding max length', () => {
      const result = DataSourceSchema.safeParse({
        ...validSource,
        tags: ['a'.repeat(51)],
      });
      expect(result.success).toBe(false);
    });

    it('rejects more than 20 tags', () => {
      const result = DataSourceSchema.safeParse({
        ...validSource,
        tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      const result = DataSourceSchema.safeParse({ ...validSource, extra: 'nope' });
      expect(result.success).toBe(false);
    });
  });

  describe('ColumnSchemaExtendedSchema', () => {
    const validColumn = {
      id: 'col-1',
      catalogEntryId: 'ce-1',
      columnName: 'id',
      columnType: 'INTEGER',
      arrowType: 'Int32',
      nullable: false,
      ordinalPosition: 0,
    };

    it('accepts valid column schema', () => {
      const result = ColumnSchemaExtendedSchema.safeParse(validColumn);
      expect(result.success).toBe(true);
    });

    it('accepts with optional fields', () => {
      const result = ColumnSchemaExtendedSchema.safeParse({
        ...validColumn,
        dataSourceId: 'ds-1',
        isNumeric: true,
        isCategorical: false,
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing columnName', () => {
      const { columnName: _, ...rest } = validColumn;
      const result = ColumnSchemaExtendedSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects negative ordinalPosition', () => {
      const result = ColumnSchemaExtendedSchema.safeParse({
        ...validColumn,
        ordinalPosition: -1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('GetSourcesRequestSchema', () => {
    it('accepts empty object (no filters)', () => {
      const result = GetSourcesRequestSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts with status filter', () => {
      const result = GetSourcesRequestSchema.safeParse({
        filters: { status: ['active', 'stale'] },
      });
      expect(result.success).toBe(true);
    });

    it('accepts with format filter', () => {
      const result = GetSourcesRequestSchema.safeParse({
        filters: { format: ['csv', 'parquet'] },
      });
      expect(result.success).toBe(true);
    });

    it('accepts with tags filter', () => {
      const result = GetSourcesRequestSchema.safeParse({
        filters: { tags: ['important'] },
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid status in filter', () => {
      const result = GetSourcesRequestSchema.safeParse({
        filters: { status: ['invalid'] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields in filters (strict)', () => {
      const result = GetSourcesRequestSchema.safeParse({
        filters: { status: ['active'], extra: true },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('RemoveSourceRequestSchema', () => {
    it('accepts valid request', () => {
      const result = RemoveSourceRequestSchema.safeParse({ dataSourceId: 'ds-1' });
      expect(result.success).toBe(true);
    });

    it('rejects empty dataSourceId', () => {
      const result = RemoveSourceRequestSchema.safeParse({ dataSourceId: '' });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      const result = RemoveSourceRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        extra: true,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('UpdateSourceRequestSchema', () => {
    it('accepts valid request with name update', () => {
      const result = UpdateSourceRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        updates: { name: 'new name' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts valid request with tags update', () => {
      const result = UpdateSourceRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        updates: { tags: ['tag1', 'tag2'] },
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty updates object', () => {
      const result = UpdateSourceRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        updates: {},
      });
      expect(result.success).toBe(true);
    });

    it('rejects name exceeding 255 chars', () => {
      const result = UpdateSourceRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        updates: { name: 'a'.repeat(256) },
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields in updates (strict)', () => {
      const result = UpdateSourceRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        updates: { name: 'ok', extra: true },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('GetColumnStatsRequestSchema', () => {
    it('accepts valid request', () => {
      const result = GetColumnStatsRequestSchema.safeParse({ dataSourceId: 'ds-1' });
      expect(result.success).toBe(true);
    });

    it('accepts with forceRecompute', () => {
      const result = GetColumnStatsRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        forceRecompute: true,
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty dataSourceId', () => {
      const result = GetColumnStatsRequestSchema.safeParse({ dataSourceId: '' });
      expect(result.success).toBe(false);
    });

    it('rejects extra fields (strict)', () => {
      const result = GetColumnStatsRequestSchema.safeParse({
        dataSourceId: 'ds-1',
        extra: true,
      });
      expect(result.success).toBe(false);
    });
  });
});
