/**
 * Compile-time type assertions verifying Zod-inferred types
 * are assignable to WorkerMessage and vice versa.
 */

import type { WorkerInboundMessage, WorkerOutboundMessage } from '@shared/schemas/worker-schemas';
import type { WorkerMessage } from '@shared/types';
import { describe, expect, it } from 'vitest';

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
