import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'canceled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunEventTypeSchema = z.enum([
  'run.created',
  'run.started',
  'step.started',
  'step.completed',
  'artifact.created',
  'approval.requested',
  'approval.decided',
  'run.succeeded',
  'run.failed',
  'run.canceled',
  'heartbeat',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

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
