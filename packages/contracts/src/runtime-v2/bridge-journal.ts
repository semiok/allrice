import { z } from 'zod';

import { BridgeCommandPayloadSchema } from '../bridge.ts';
import { TimestampSchema, UuidSchema } from '../common.ts';
import { RuntimeAttemptRefSchema } from './identity.ts';
import {
  RuntimeOperationSignalSchema,
  RuntimeOperationSnapshotSchema,
} from './operations.ts';

/** Opt-in ledger transport, deliberately NOT a new legacy Bridge capability. */
export const RuntimeBridgeDispatchSchema = z
  .object({
    contractVersion: z.literal(1),
    snapshot: RuntimeOperationSnapshotSchema,
    payload: BridgeCommandPayloadSchema,
    leaseToken: UuidSchema,
    leaseExpiresAt: TimestampSchema,
    grantRootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const binding = value.snapshot.binding;
    if (
      binding.execution.targetKind !== 'rice_bridge' ||
      binding.execution.deviceId === null ||
      binding.execution.scopeDigest !==
        `sha256:${value.grantRootFingerprint}` ||
      binding.action !== value.payload.capability ||
      value.snapshot.status !== 'dispatched' ||
      value.snapshot.processId !== null ||
      value.snapshot.cancelRequestId !== null
    ) {
      context.addIssue({ code: 'custom', message: 'invalid Bridge dispatch' });
    }
  });
export type RuntimeBridgeDispatch = z.infer<typeof RuntimeBridgeDispatchSchema>;

export const RuntimeBridgeReceiptSchema = z
  .object({
    contractVersion: z.literal(1),
    receiptId: UuidSchema,
    attempt: RuntimeAttemptRefSchema,
    leaseToken: UuidSchema,
    // Local journal order only. PostgreSQL assigns canonical event sequence.
    deviceSequence: z.number().int().min(0).max(100),
    signal: RuntimeOperationSignalSchema,
    evidence: z
      .object({
        summary: z.string().min(1).max(500),
        output: z.unknown().optional(),
        errorCode: z.string().min(1).max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      [
        'operation.started',
        'operation.uncertain',
        'operation.outcome',
        'operation.stopped',
      ].includes(value.signal.type),
    'devices cannot emit scheduling or authorization facts',
  )
  .refine(
    (value) =>
      !['operation.outcome', 'operation.stopped'].includes(value.signal.type) ||
      value.evidence !== undefined,
    'known outcomes require their bounded evidence body',
  );
export type RuntimeBridgeReceipt = z.infer<typeof RuntimeBridgeReceiptSchema>;

export const RuntimeBridgeStartSchema = z
  .object({
    contractVersion: z.literal(1),
    receiptId: UuidSchema,
    attempt: RuntimeAttemptRefSchema,
    leaseToken: UuidSchema,
  })
  .strict();

export const RuntimeBridgeStartResponseSchema = z
  .object({ snapshot: RuntimeOperationSnapshotSchema, mayExecute: z.boolean() })
  .strict();

export const RuntimeBridgeReceiptAckSchema = z
  .object({
    receiptId: UuidSchema,
    accepted: z.literal(true),
    // A durable receipt acknowledgment is not an execution authorization.
  })
  .strict();

/** JSON canonical form used for immutable transport fingerprints, not permission. */
export function canonicalRuntimeBridgeJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalRuntimeBridgeJson).join(',')}]`;
  }
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalRuntimeBridgeJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  throw new Error('Non-JSON Bridge value');
}
