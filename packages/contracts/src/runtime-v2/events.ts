import { z } from 'zod';

import { TimestampSchema, UuidSchema } from '../common.ts';
import {
  RuntimeAttemptRefSchema,
  RuntimeContractVersionSchema,
  RuntimeCounterSchema,
  RuntimeExecutionScopeSchema,
  RuntimeTaskRefSchema,
  runtimeContractEqual,
} from './identity.ts';
import {
  RuntimeOperationSignalSchema,
  RuntimeOperationSnapshotSchema,
  advanceRuntimeOperation,
  type RuntimeOperationSnapshot,
} from './operations.ts';

const header = z
  .object({
    family: z.literal('allrice.runtime.operation'),
    contractVersion: z.number().int().positive(),
    eventId: UuidSchema,
    task: RuntimeTaskRefSchema,
    attempt: RuntimeAttemptRefSchema,
    execution: RuntimeExecutionScopeSchema,
    // Contiguous, zero-based per operation attempt. NOT the legacy Run sequence.
    sequence: RuntimeCounterSchema,
    occurredAt: TimestampSchema,
    signal: z.unknown(),
  })
  .strict();

export const RuntimeOperationEventSchema = header
  .extend({
    contractVersion: RuntimeContractVersionSchema,
    signal: RuntimeOperationSignalSchema,
  })
  .strict();
export type RuntimeOperationEvent = z.infer<typeof RuntimeOperationEventSchema>;

type DecodeFailure =
  'invalid_event' | 'unsupported_version' | 'unsupported_type';
export type RuntimeOperationEventDecodeResult =
  | { ok: true; event: RuntimeOperationEvent }
  | { ok: false; reason: DecodeFailure };

/** Unknown versions/types are explicit failures, never interpreted as success or permission. */
export function decodeRuntimeOperationEvent(
  input: unknown,
): RuntimeOperationEventDecodeResult {
  const envelope = header.safeParse(input);
  if (!envelope.success) return { ok: false, reason: 'invalid_event' };
  if (envelope.data.contractVersion !== 1)
    return { ok: false, reason: 'unsupported_version' };
  const tag = z
    .object({ type: z.string().min(1).max(160) })
    .safeParse(envelope.data.signal);
  if (!tag.success) return { ok: false, reason: 'invalid_event' };
  if (
    !RuntimeOperationSignalSchema.options.some(
      (option) => option.shape.type.value === tag.data.type,
    )
  ) {
    return { ok: false, reason: 'unsupported_type' };
  }
  const event = RuntimeOperationEventSchema.safeParse(envelope.data);
  return event.success
    ? { ok: true, event: event.data }
    : { ok: false, reason: 'invalid_event' };
}

export type RuntimeOperationReplayFailure =
  | DecodeFailure
  | 'task_mismatch'
  | 'operation_mismatch'
  | 'attempt_mismatch'
  | 'execution_scope_mismatch'
  | 'event_id_conflict'
  | 'sequence_conflict'
  | 'sequence_gap'
  | 'illegal_transition'
  | 'invalid_initial_state'
  | 'replay_limit';

export interface RuntimeOperationReplayResult {
  snapshot: RuntimeOperationSnapshot;
  nextSequence: number;
  applied: number;
  duplicates: number;
  blocked: { index: number; reason: RuntimeOperationReplayFailure } | null;
}

/**
 * Rebuild a bounded, complete attempt prefix from sequence 0. No sorting, IO,
 * dispatch, retry, billing or authorization. Callers retain rejected/late evidence
 * for reconciliation; they must NOT append it to a terminal legacy RunEvent stream.
 * P03 supplies durable unique constraints, trust resolution and transactional use.
 */
export function replayRuntimeOperationEvents(
  initial: RuntimeOperationSnapshot,
  inputs: readonly unknown[],
): RuntimeOperationReplayResult {
  let snapshot = RuntimeOperationSnapshotSchema.parse(initial);
  const report: RuntimeOperationReplayResult = {
    snapshot,
    nextSequence: 0,
    applied: 0,
    duplicates: 0,
    blocked: null,
  };
  const byId = new Map<string, RuntimeOperationEvent>();
  const bySequence = new Map<number, string>();
  const block = (index: number, reason: RuntimeOperationReplayFailure) => ({
    ...report,
    snapshot,
    blocked: { index, reason },
  });
  if (initial.status !== 'planned' || initial.processId !== null)
    return block(0, 'invalid_initial_state');
  if (inputs.length > 10_000) return block(0, 'replay_limit');

  for (const [index, input] of inputs.entries()) {
    const decoded = decodeRuntimeOperationEvent(input);
    if (!decoded.ok) return block(index, decoded.reason);
    const event = decoded.event;
    if (!runtimeContractEqual(event.task, snapshot.binding.task))
      return block(index, 'task_mismatch');
    if (event.attempt.operationId !== snapshot.binding.attempt.operationId)
      return block(index, 'operation_mismatch');
    if (!runtimeContractEqual(event.attempt, snapshot.binding.attempt))
      return block(index, 'attempt_mismatch');
    if (!runtimeContractEqual(event.execution, snapshot.binding.execution))
      return block(index, 'execution_scope_mismatch');
    const previous = byId.get(event.eventId);
    if (previous) {
      if (!runtimeContractEqual(event, previous))
        return block(index, 'event_id_conflict');
      report.duplicates++;
      continue;
    }
    if (bySequence.has(event.sequence))
      return block(index, 'sequence_conflict');
    if (event.sequence !== report.nextSequence)
      return block(index, 'sequence_gap');
    try {
      snapshot = advanceRuntimeOperation(snapshot, event.signal);
    } catch {
      return block(index, 'illegal_transition');
    }
    byId.set(event.eventId, event);
    bySequence.set(event.sequence, event.eventId);
    report.nextSequence++;
    report.applied++;
  }
  return { ...report, snapshot };
}
