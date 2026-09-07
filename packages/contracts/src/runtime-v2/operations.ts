import { z } from 'zod';

import { UuidSchema } from '../common.ts';
import {
  RuntimeActionBindingSchema,
  RuntimeContractVersionSchema,
  RuntimeEvidenceRefSchema,
} from './identity.ts';

export const RuntimeOperationStatusSchema = z.enum([
  'planned',
  'waiting_user',
  'waiting_device',
  'waiting_dependency',
  'ready',
  'dispatched',
  'running',
  'cancel_requested',
  'unknown',
  'succeeded',
  'failed',
  'canceled',
  'partial',
]);
export type RuntimeOperationStatus = z.infer<
  typeof RuntimeOperationStatusSchema
>;

export const RuntimeOperationResultSchema = z
  .object({
    status: z.enum(['succeeded', 'failed', 'canceled', 'partial']),
    effects: z.enum(['none', 'applied', 'partial']),
    evidence: RuntimeEvidenceRefSchema,
  })
  .strict()
  .superRefine((result, ctx) => {
    if (
      (result.status === 'canceled' && result.effects !== 'none') ||
      (result.status === 'partial' && result.effects !== 'partial') ||
      (result.status === 'succeeded' && result.effects === 'partial')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'outcome must describe known effects truthfully',
      });
    }
  });

export function isTerminalRuntimeOperationStatus(
  status: RuntimeOperationStatus,
): boolean {
  return ['succeeded', 'failed', 'canceled', 'partial'].includes(
    RuntimeOperationStatusSchema.parse(status),
  );
}

/** One action attempt projection, not the Run or a process/Agent lifecycle. */
export const RuntimeOperationSnapshotSchema = z
  .object({
    contractVersion: RuntimeContractVersionSchema,
    binding: RuntimeActionBindingSchema,
    // These identities are intentionally not aliases of each other or of Run.id.
    stepId: UuidSchema.nullable(),
    agentInstanceId: UuidSchema.nullable(),
    processId: UuidSchema.nullable(),
    // Intent survives a subsequent unknown result or racing completion.
    cancelRequestId: UuidSchema.nullable(),
    idempotencyKey: UuidSchema,
    status: RuntimeOperationStatusSchema,
    result: RuntimeOperationResultSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.status === 'cancel_requested' &&
      snapshot.cancelRequestId === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'cancel-requested state requires the accepted intent',
      });
    }
    if (
      [
        'planned',
        'waiting_user',
        'waiting_device',
        'waiting_dependency',
        'ready',
      ].includes(snapshot.status) &&
      (snapshot.processId !== null || snapshot.cancelRequestId !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'pre-dispatch preparation cannot contain a process or cancellation intent',
      });
    }
    if (
      isTerminalRuntimeOperationStatus(snapshot.status) !==
        (snapshot.result !== null) ||
      (snapshot.result !== null && snapshot.result.status !== snapshot.status)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'terminal state requires its matching result evidence',
      });
    }
  });
export type RuntimeOperationSnapshot = z.infer<
  typeof RuntimeOperationSnapshotSchema
>;

export const RuntimeOperationSignalSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('operation.waiting'),
      reason: z.enum(['user', 'device', 'dependency']),
    })
    .strict(),
  z.object({ type: z.literal('operation.ready') }).strict(),
  z.object({ type: z.literal('operation.dispatched') }).strict(),
  z
    .object({
      type: z.literal('operation.started'),
      processId: UuidSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal('operation.transport_ack') }).strict(),
  z
    .object({
      type: z.literal('operation.cancel_requested'),
      requestId: UuidSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('operation.uncertain'),
      reason: z.enum(['connection_lost', 'lease_lost', 'receipt_missing']),
    })
    .strict(),
  z
    .object({
      type: z.literal('operation.outcome'),
      result: RuntimeOperationResultSchema.refine(
        (result) => result.status !== 'canceled',
        'cancellation requires stopped evidence',
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('operation.stopped'),
      evidence: RuntimeEvidenceRefSchema,
      effects: z.enum(['none', 'partial']),
    })
    .strict(),
]);
export type RuntimeOperationSignal = z.infer<
  typeof RuntimeOperationSignalSchema
>;

const waiting = [
  'waiting_user',
  'waiting_device',
  'waiting_dependency',
] as const;
const knownOutcomes = ['succeeded', 'failed', 'partial'] as const;
const transitions: Readonly<
  Record<RuntimeOperationStatus, readonly RuntimeOperationStatus[]>
> = {
  planned: [...waiting, 'ready', 'cancel_requested'],
  waiting_user: [
    'waiting_device',
    'waiting_dependency',
    'ready',
    'cancel_requested',
  ],
  waiting_device: [
    'waiting_user',
    'waiting_dependency',
    'ready',
    'cancel_requested',
  ],
  waiting_dependency: [
    'waiting_user',
    'waiting_device',
    'ready',
    'cancel_requested',
  ],
  ready: [...waiting, 'dispatched', 'cancel_requested'],
  dispatched: ['running', 'unknown', 'cancel_requested', ...knownOutcomes],
  running: ['unknown', 'cancel_requested', ...knownOutcomes],
  cancel_requested: ['unknown', ...knownOutcomes, 'canceled'],
  unknown: [...knownOutcomes, 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
  partial: [],
};

/** A scheduling/state precondition, NEVER permission to dispatch or retry. */
export function canTransitionRuntimeOperation(
  from: RuntimeOperationStatus,
  to: RuntimeOperationStatus,
): boolean {
  return transitions[RuntimeOperationStatusSchema.parse(from)].includes(
    RuntimeOperationStatusSchema.parse(to),
  );
}

/** Pure projection of already authenticated, durably ordered evidence (P03/P04 adapters). */
export function advanceRuntimeOperation(
  snapshotInput: RuntimeOperationSnapshot,
  signalInput: RuntimeOperationSignal,
): RuntimeOperationSnapshot {
  const snapshot = RuntimeOperationSnapshotSchema.parse(snapshotInput);
  const signal = RuntimeOperationSignalSchema.parse(signalInput);
  let status: RuntimeOperationStatus;
  let result: RuntimeOperationSnapshot['result'] = null;
  let processId = snapshot.processId;
  let cancelRequestId = snapshot.cancelRequestId;
  switch (signal.type) {
    case 'operation.transport_ack':
      return snapshot;
    case 'operation.waiting':
      status = `waiting_${signal.reason}`;
      break;
    case 'operation.ready':
      status = 'ready';
      break;
    case 'operation.dispatched':
      status = 'dispatched';
      break;
    case 'operation.started':
      if (
        snapshot.processId !== null &&
        signal.processId !== snapshot.processId
      ) {
        throw new Error('operation attempt process identity changed');
      }
      // Startup can race cancellation or arrive after a lost receipt. It proves
      // a process association, not that cancellation vanished or effects are known.
      if (
        ['cancel_requested', 'unknown', 'running'].includes(snapshot.status)
      ) {
        return RuntimeOperationSnapshotSchema.parse({
          ...snapshot,
          processId: signal.processId,
        });
      }
      status = 'running';
      processId = signal.processId;
      break;
    case 'operation.cancel_requested':
      cancelRequestId ??= signal.requestId;
      if (
        snapshot.status === 'unknown' ||
        snapshot.status === 'cancel_requested'
      ) {
        return RuntimeOperationSnapshotSchema.parse({
          ...snapshot,
          cancelRequestId,
        });
      }
      status = 'cancel_requested';
      break;
    case 'operation.uncertain':
      if (snapshot.status === 'unknown') return snapshot;
      status = 'unknown';
      break;
    case 'operation.outcome':
      result = signal.result;
      status = result.status;
      break;
    case 'operation.stopped':
      status = signal.effects === 'none' ? 'canceled' : 'partial';
      result = { status, effects: signal.effects, evidence: signal.evidence };
      break;
  }
  if (!canTransitionRuntimeOperation(snapshot.status, status)) {
    throw new Error(
      `illegal operation transition: ${snapshot.status} -> ${status}`,
    );
  }
  return RuntimeOperationSnapshotSchema.parse({
    ...snapshot,
    status,
    processId,
    cancelRequestId,
    result,
  });
}
