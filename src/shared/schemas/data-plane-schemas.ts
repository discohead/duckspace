/**
 * Zod runtime validation schemas for Data Plane messages.
 *
 * These schemas mirror the TypeScript types in `src/shared/types.ts` (section 2)
 * and are used to validate messages flowing over the MessagePort data channel
 * between DuckDB Worker and Renderer (via Main bridge).
 */

import { z } from 'zod';

// ============================================================
// Worker -> Renderer messages (data plane outbound)
// ============================================================

/**
 * Schema for Arrow IPC batch messages sent from Worker to Renderer on the data plane.
 * Validates batch metadata including query ID, batch index, row count, and byte size.
 */
export const ArrowBatchMessageSchema = z
  .object({
    type: z.literal('arrow-batch'),
    queryId: z.string(),
    index: z.number().int().nonnegative(),
    totalBatches: z.number().int().positive().optional(),
    rowCount: z.number().int().nonnegative(),
    byteSize: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Arrow IPC batch sent from Worker to Renderer');

/**
 * Schema for stream completion signals sent from Worker to Renderer.
 * Indicates all batches have been sent, with final totals for batches, rows, bytes, and duration.
 */
export const StreamEndMessageSchema = z
  .object({
    type: z.literal('arrow-end'),
    queryId: z.string(),
    totalBatches: z.number().int().nonnegative(),
    totalRows: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  })
  .strict()
  .describe('Stream completion signal from Worker to Renderer');

/**
 * Schema for error messages delivered on the data plane from Worker to Renderer.
 * Includes the error code, message, and the number of batches sent before the error.
 */
export const DataPlaneErrorSchema = z
  .object({
    type: z.literal('arrow-error'),
    queryId: z.string(),
    code: z.string(),
    message: z.string(),
    batchesSent: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Error delivered on the data plane from Worker to Renderer');

// ============================================================
// Renderer -> Worker messages (data plane inbound)
// ============================================================

/**
 * Schema for backpressure acknowledgment messages sent from Renderer to Worker.
 * Each ACK releases a slot in the sliding window for the next batch.
 */
export const BatchAckMessageSchema = z
  .object({
    type: z.literal('ack'),
    queryId: z.string(),
    index: z.number().int().nonnegative(),
  })
  .strict()
  .describe('Backpressure acknowledgment from Renderer to Worker');

/**
 * Schema for cancellation requests sent from Renderer to Worker via the data plane.
 * Includes an optional reason (user_cancelled, component_unmounted, timeout, superseded).
 */
export const DataPlaneCancelMessageSchema = z
  .object({
    type: z.literal('cancel'),
    queryId: z.string(),
    reason: z.enum(['user_cancelled', 'component_unmounted', 'timeout', 'superseded']).optional(),
  })
  .strict()
  .describe('Cancellation request from Renderer to Worker via data plane');

// ============================================================
// Discriminated unions
// ============================================================

/**
 * Discriminated union of all data plane messages flowing from Worker to Renderer.
 * Includes arrow-batch, arrow-end, and arrow-error message types.
 */
export const DataPlaneOutboundSchema = z
  .discriminatedUnion('type', [
    ArrowBatchMessageSchema,
    StreamEndMessageSchema,
    DataPlaneErrorSchema,
  ])
  .describe('Union of all data plane messages from Worker to Renderer');

/**
 * Discriminated union of all data plane messages flowing from Renderer to Worker.
 * Includes ack and cancel message types.
 */
export const DataPlaneInboundSchema = z
  .discriminatedUnion('type', [BatchAckMessageSchema, DataPlaneCancelMessageSchema])
  .describe('Union of all data plane messages from Renderer to Worker');

/**
 * Discriminated union of all data plane messages in both directions.
 * Combines outbound (Worker to Renderer) and inbound (Renderer to Worker) message types.
 */
export const DataPlaneMessageSchema = z
  .discriminatedUnion('type', [
    ArrowBatchMessageSchema,
    StreamEndMessageSchema,
    DataPlaneErrorSchema,
    BatchAckMessageSchema,
    DataPlaneCancelMessageSchema,
  ])
  .describe('Union of all data plane messages');

// ============================================================
// Inferred types
// ============================================================

/** Inferred TypeScript type for all outbound data plane messages (Worker to Renderer). */
export type DataPlaneOutbound = z.infer<typeof DataPlaneOutboundSchema>;

/** Inferred TypeScript type for all inbound data plane messages (Renderer to Worker). */
export type DataPlaneInbound = z.infer<typeof DataPlaneInboundSchema>;
