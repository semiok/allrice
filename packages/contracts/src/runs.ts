import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const HarnessEventSourceSchema = z.enum(['codex', 'dsh']);

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'canceled',
  'needs_attention',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunEventTypeSchema = z.enum([
  'run.created',
  'run.started',
  'run.retrying',
  'session.bound',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.canceled',
  'routing.selected',
  'step.started',
  'step.completed',
  'step.waiting_approval',
  'step.retrying',
  'step.compensating',
  'step.compensated',
  'assistant.text.delta',
  'assistant.text.completed',
  'harness.native',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'artifact.created',
  'approval.requested',
  'approval.decided',
  'knowledge.retrieved',
  'context.compaction.started',
  'context.compaction.completed',
  'context.compaction.failed',
  'context.checkpoint.created',
  'usage.updated',
  'run.succeeded',
  'run.failed',
  'run.canceled',
  'run.needs_attention',
  'heartbeat',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RuntimeEventCategorySchema = z.enum([
  'run',
  'assistant',
  'tool',
  'workflow',
  'approval',
  'artifact',
  'knowledge',
  'context',
  'system',
  'session',
  'turn',
  'usage',
  'routing',
]);
export type RuntimeEventCategory = z.infer<typeof RuntimeEventCategorySchema>;

export const RuntimeEventPhaseSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
  'info',
]);
export type RuntimeEventPhase = z.infer<typeof RuntimeEventPhaseSchema>;

export const AssistantTextEventPayloadSchema = z
  .object({
    text: z.string().max(100_000),
    source: HarnessEventSourceSchema,
    generation: z.number().int().nonnegative().optional(),
    turnId: z.string().trim().min(1).nullable().optional(),
    attempt: z.number().int().positive().optional(),
    order: z.number().int().positive().optional(),
    orderStart: z.number().int().positive().optional(),
    messageId: UuidSchema.optional(),
  })
  .strict();

export const ToolEventPayloadSchema = z
  .object({
    toolCallId: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    label: z.string().min(1).max(200),
    source: z.union([HarnessEventSourceSchema, z.literal('tool_broker')]),
    status: z.enum(['started', 'completed', 'failed']),
    summary: z.string().max(1_000).optional(),
    itemCount: z.number().int().nonnegative().optional(),
    attempt: z.number().int().positive().optional(),
    generation: z.number().int().nonnegative().optional(),
    turnId: z.string().trim().min(1).nullable().optional(),
    order: z.number().int().positive().optional(),
    messageId: UuidSchema.optional(),
  })
  .strict();

export const RunRetryingEventPayloadSchema = z
  .object({
    code: z.string().min(1).max(160),
    attempt: z.number().int().nonnegative(),
    availableAt: TimestampSchema,
  })
  .strict();

export const RunEventSchema = z
  .object({
    eventId: UuidSchema,
    runId: UuidSchema,
    sequence: z.number().int().nonnegative(),
    type: RunEventTypeSchema,
    schemaVersion: z.literal(1),
    occurredAt: TimestampSchema,
    payload: z.unknown(),
  })
  .strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ChatFlowEventEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(3),
    eventId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    conversationId: UuidSchema.nullable(),
    runId: UuidSchema,
    generation: z.number().int().nonnegative().nullable(),
    cursor: z.string().trim().min(1),
    sequence: z.number().int().nonnegative(),
    harness: HarnessEventSourceSchema.nullable(),
    type: RunEventTypeSchema,
    occurredAt: TimestampSchema,
    sourceEvent: z
      .object({
        id: z.string().trim().min(1).max(240),
        type: z.string().trim().min(1).max(240),
        occurredAt: TimestampSchema,
        payload: z.record(z.string(), z.unknown()),
      })
      .strict()
      .nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ChatFlowEventEnvelope = z.infer<typeof ChatFlowEventEnvelopeSchema>;

/**
 * Stable presentation envelope shared by Codex, DSH and future harnesses.
 * It intentionally wraps the durable RunEvent instead of exposing a harness
 * wire protocol to product clients.
 */
export const CanonicalRuntimeEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: UuidSchema,
    runId: UuidSchema,
    sequence: z.number().int().nonnegative(),
    occurredAt: TimestampSchema,
    type: RunEventTypeSchema,
    category: RuntimeEventCategorySchema,
    phase: RuntimeEventPhaseSchema,
    harness: HarnessEventSourceSchema.nullable(),
    generation: z.number().int().nonnegative().nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CanonicalRuntimeEvent = z.infer<typeof CanonicalRuntimeEventSchema>;

function runtimeEventCategory(type: RunEventType): RuntimeEventCategory {
  if (type.startsWith('session.')) return 'session';
  if (type.startsWith('turn.')) return 'turn';
  if (type === 'usage.updated') return 'usage';
  if (type.startsWith('routing.')) return 'routing';
  if (type.startsWith('assistant.')) return 'assistant';
  if (type === 'harness.native') return 'system';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('step.')) return 'workflow';
  if (type.startsWith('approval.')) return 'approval';
  if (type.startsWith('artifact.')) return 'artifact';
  if (type.startsWith('knowledge.')) return 'knowledge';
  if (type.startsWith('context.')) return 'context';
  if (type === 'heartbeat') return 'system';
  return 'run';
}

function runtimeEventPhase(type: RunEventType): RuntimeEventPhase {
  if (type === 'run.created') return 'queued';
  if (type.endsWith('.failed') || type === 'run.needs_attention')
    return 'failed';
  if (type.endsWith('.canceled')) return 'canceled';
  if (
    type.endsWith('.completed') ||
    type.endsWith('.succeeded') ||
    type === 'artifact.created' ||
    type === 'approval.decided' ||
    type === 'knowledge.retrieved' ||
    type === 'context.checkpoint.created'
  )
    return 'succeeded';
  if (type.includes('waiting') || type === 'approval.requested')
    return 'waiting';
  if (
    type.endsWith('.started') ||
    type.endsWith('.retrying') ||
    type === 'assistant.text.delta'
  )
    return 'running';
  return 'info';
}

export function canonicalizeRunEvent(input: RunEvent): CanonicalRuntimeEvent {
  const event = RunEventSchema.parse(input);
  const payload =
    event.payload !== null &&
    typeof event.payload === 'object' &&
    !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : { value: event.payload };
  const source = payload.source;
  const generation = payload.generation;
  return CanonicalRuntimeEventSchema.parse({
    schemaVersion: 1,
    eventId: event.eventId,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
    category: runtimeEventCategory(event.type),
    phase: runtimeEventPhase(event.type),
    harness: source === 'codex' || source === 'dsh' ? source : null,
    generation:
      typeof generation === 'number' &&
      Number.isInteger(generation) &&
      generation >= 0
        ? generation
        : null,
    payload,
  });
}

const terminalRunStatuses = new Set<RunStatus>([
  'succeeded',
  'failed',
  'canceled',
]);

export function isTerminalRunStatus(status: RunStatus) {
  return terminalRunStatuses.has(status);
}

export const ChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ArtifactSchema = z
  .object({
    id: UuidSchema,
    runId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    objectKey: z.string().min(1).max(1024),
    checksum: ChecksumSchema,
    mediaType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();

export const AuditEventSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    actorId: UuidSchema.nullable(),
    action: z.string().min(1).max(128),
    resourceType: z.string().min(1).max(64),
    resourceId: UuidSchema.nullable(),
    decision: z.enum(['allowed', 'denied', 'recorded']),
    reason: z.string().min(1).max(255),
    occurredAt: TimestampSchema,
    requestId: UuidSchema.nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

const terminalEvents = new Set<RunEventType>([
  'run.succeeded',
  'run.failed',
  'run.canceled',
]);

export function validateRunEventSequence(eventsInput: RunEvent[]) {
  const events = eventsInput.map((event) => RunEventSchema.parse(event));
  const firstEvent = events[0];
  if (!firstEvent) return;
  const runId = firstEvent.runId;
  const ids = new Set<string>();
  let terminal = false;
  for (const [index, event] of events.entries()) {
    if (event.runId !== runId) throw new Error('mixed run IDs in event stream');
    if (ids.has(event.eventId)) throw new Error('duplicate run event ID');
    ids.add(event.eventId);
    if (event.sequence !== index) {
      throw new Error(`run event sequence gap at ${event.sequence}`);
    }
    if (terminal) throw new Error('run event emitted after terminal event');
    terminal = terminalEvents.has(event.type);
  }
}
