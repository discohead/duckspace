/**
 * Compile-time type assertions verifying Zod-inferred types
 * are assignable to WorkerMessage and vice versa.
 */

import type { ColumnStatisticsSchema, DataSourceSchema } from '@shared/schemas/catalog-schemas';
import type { IngestionJobSchema, WatchDirectorySchema } from '@shared/schemas/ingestion-schemas';
import type { WorkerInboundMessage, WorkerOutboundMessage } from '@shared/schemas/worker-schemas';
import type {
  ColumnStatisticsRecord,
  DataSource,
  IngestionJob,
  WatchDirectory,
  WorkerMessage,
} from '@shared/types';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

/** Recursively strips `readonly` from all properties (deep + ReadonlyArray → Array). */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [P in keyof T]: Mutable<T[P]> }
    : T;

describe('C9: Zod-TypeScript type alignment', () => {
  it('every outbound Zod type is a valid WorkerMessage', () => {
    // Compile-time: if types diverge, this assignment fails
    type AssertOutboundCompat = WorkerOutboundMessage extends WorkerMessage ? true : never;
    const _check: AssertOutboundCompat = true;
    expect(_check).toBe(true);
  });

  it('every inbound Zod type is a valid WorkerMessage', () => {
    type AssertInboundCompat = WorkerInboundMessage extends WorkerMessage ? true : never;
    const _check: AssertInboundCompat = true;
    expect(_check).toBe(true);
  });

  it('WorkerMessage is fully covered by Zod unions', () => {
    // Bidirectional: WorkerMessage should be exactly the union of inbound + outbound
    type ZodUnion = WorkerInboundMessage | WorkerOutboundMessage;
    type AssertBidirectional = WorkerMessage extends ZodUnion ? true : never;
    const _check: AssertBidirectional = true;
    expect(_check).toBe(true);
  });
});

describe('Entity schema-interface alignment', () => {
  it('DataSourceSchema matches DataSource interface', () => {
    type SchemaType = z.infer<typeof DataSourceSchema>;
    type AssertForward = SchemaType extends Mutable<DataSource> ? true : never;
    type AssertReverse = Mutable<DataSource> extends SchemaType ? true : never;
    const _fwd: AssertForward = true;
    const _rev: AssertReverse = true;
    expect(_fwd).toBe(true);
    expect(_rev).toBe(true);
  });

  it('IngestionJobSchema matches IngestionJob interface', () => {
    type SchemaType = z.infer<typeof IngestionJobSchema>;
    type AssertForward = SchemaType extends Mutable<IngestionJob> ? true : never;
    type AssertReverse = Mutable<IngestionJob> extends SchemaType ? true : never;
    const _fwd: AssertForward = true;
    const _rev: AssertReverse = true;
    expect(_fwd).toBe(true);
    expect(_rev).toBe(true);
  });

  it('WatchDirectorySchema matches WatchDirectory interface', () => {
    type SchemaType = z.infer<typeof WatchDirectorySchema>;
    type AssertForward = SchemaType extends Mutable<WatchDirectory> ? true : never;
    type AssertReverse = Mutable<WatchDirectory> extends SchemaType ? true : never;
    const _fwd: AssertForward = true;
    const _rev: AssertReverse = true;
    expect(_fwd).toBe(true);
    expect(_rev).toBe(true);
  });

  it('ColumnStatisticsSchema matches ColumnStatisticsRecord interface', () => {
    type SchemaType = z.infer<typeof ColumnStatisticsSchema>;
    type AssertForward = SchemaType extends Mutable<ColumnStatisticsRecord> ? true : never;
    type AssertReverse = Mutable<ColumnStatisticsRecord> extends SchemaType ? true : never;
    const _fwd: AssertForward = true;
    const _rev: AssertReverse = true;
    expect(_fwd).toBe(true);
    expect(_rev).toBe(true);
  });
});
