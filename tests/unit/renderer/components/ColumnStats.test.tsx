// @vitest-environment jsdom

import { ColumnStats } from '@renderer/components/ColumnStats';
import type { ColumnStatisticsRecord } from '@shared/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

const baseStat: ColumnStatisticsRecord = {
  id: 'ds1__age',
  dataSourceId: 'ds1',
  columnName: 'age',
  columnType: 'INTEGER',
  rowCount: 1000,
  nullCount: 50,
  nullPercentage: 5.0,
  distinctCount: 80,
  computedAt: '2024-01-01T00:00:00Z',
};

describe('ColumnStats', () => {
  it('renders column name and type badge', () => {
    render(<ColumnStats stat={baseStat} />);
    expect(screen.getByText('age')).toBeDefined();
    expect(screen.getByText('INTEGER')).toBeDefined();
  });

  it('renders row count, null count, and distinct count', () => {
    render(<ColumnStats stat={baseStat} />);
    expect(screen.getByText('Rows')).toBeDefined();
    expect(screen.getByText('Nulls')).toBeDefined();
    expect(screen.getByText('Distinct')).toBeDefined();
    expect(screen.getByText((1000).toLocaleString())).toBeDefined();
    expect(screen.getByText((80).toLocaleString())).toBeDefined();
  });

  it('renders null percentage', () => {
    render(<ColumnStats stat={baseStat} />);
    expect(screen.getByText('(5.0%)')).toBeDefined();
  });

  it('renders numeric stats when min/max/mean are present', () => {
    const numericStat: ColumnStatisticsRecord = {
      ...baseStat,
      min: '0',
      max: '99',
      mean: 42.55,
      median: 40.0,
      stddev: 10.22,
    };
    render(<ColumnStats stat={numericStat} />);
    expect(screen.getByText('Min')).toBeDefined();
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText('Max')).toBeDefined();
    expect(screen.getByText('99')).toBeDefined();
    expect(screen.getByText('Mean')).toBeDefined();
    expect(screen.getByText('Median')).toBeDefined();
    expect(screen.getByText('Std Dev')).toBeDefined();
  });

  it('renders quartile stats when present', () => {
    const stat: ColumnStatisticsRecord = {
      ...baseStat,
      mean: 42,
      q25: 20,
      q75: 60,
    };
    render(<ColumnStats stat={stat} />);
    expect(screen.getByText('Q25')).toBeDefined();
    expect(screen.getByText('Q75')).toBeDefined();
  });

  it('does not render numeric section for VARCHAR without mean', () => {
    const stringStat: ColumnStatisticsRecord = {
      ...baseStat,
      columnType: 'VARCHAR',
    };
    render(<ColumnStats stat={stringStat} />);
    expect(screen.queryByText('Mean')).toBeNull();
    expect(screen.queryByText('Std Dev')).toBeNull();
  });

  it('renders top values when present', () => {
    const categoricalStat: ColumnStatisticsRecord = {
      ...baseStat,
      columnType: 'VARCHAR',
      topValues: [
        { value: 'apple', count: 200, percentage: 20.0 },
        { value: 'banana', count: 150, percentage: 15.0 },
      ],
    };
    render(<ColumnStats stat={categoricalStat} />);
    expect(screen.getByText('Top Values')).toBeDefined();
    expect(screen.getByText('apple')).toBeDefined();
    expect(screen.getByText('banana')).toBeDefined();
  });

  it('renders (empty) for empty string top value', () => {
    const stat: ColumnStatisticsRecord = {
      ...baseStat,
      columnType: 'VARCHAR',
      topValues: [{ value: '', count: 10, percentage: 1.0 }],
    };
    render(<ColumnStats stat={stat} />);
    expect(screen.getByText('(empty)')).toBeDefined();
  });

  it('treats DECIMAL(10,2) as numeric type', () => {
    const stat: ColumnStatisticsRecord = {
      ...baseStat,
      columnType: 'DECIMAL(10,2)',
      min: '0.00',
      max: '999.99',
      mean: 50.5,
    };
    render(<ColumnStats stat={stat} />);
    expect(screen.getByText('Min')).toBeDefined();
    expect(screen.getByText('Mean')).toBeDefined();
  });

  it('treats column with mean as numeric even for non-numeric type', () => {
    const stat: ColumnStatisticsRecord = {
      ...baseStat,
      columnType: 'CUSTOM_TYPE',
      mean: 42.5,
    };
    render(<ColumnStats stat={stat} />);
    expect(screen.getByText('Mean')).toBeDefined();
  });

  it('formats integer mean without decimal places', () => {
    const stat: ColumnStatisticsRecord = {
      ...baseStat,
      mean: 100,
    };
    render(<ColumnStats stat={stat} />);
    expect(screen.getByText((100).toLocaleString())).toBeDefined();
  });

  it('displays dash for undefined mean when numeric section renders', () => {
    const stat: ColumnStatisticsRecord = {
      ...baseStat,
      columnType: 'INTEGER',
      min: '0',
    };
    render(<ColumnStats stat={stat} />);
    // Mean is undefined → formatNumber returns '-'
    expect(screen.getByText('Mean')).toBeDefined();
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(1);
  });
});
