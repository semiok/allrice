import { z } from 'zod';

import { UuidSchema } from './common.ts';
import { SkillCapabilitySchema } from './skills.ts';

export const HarnessKindSchema = z.enum(['codex', 'dsh']);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

export const HarnessCapabilitiesSchema = z
  .object({
    persistentThreads: z.boolean(),
    assistantDeltas: z.boolean(),
    toolEvents: z.boolean(),
    usageEvents: z.boolean(),
    interrupt: z.boolean(),
    steer: z.boolean(),
    compact: z.boolean(),
    recover: z.boolean(),
  })
  .strict();
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;

/**
 * Product-facing capability names. The UI and employee router may use this
 * matrix for discovery, but authorization always remains in AllRice.
 */
export const RuntimeCapabilityNameSchema = z.enum([
  'persistent_threads',
  'assistant_streaming',
  'tool_events',
  'usage_events',
  'interrupt',
  'active_turn_steer',
  'context_compaction',
  'thread_recovery',
]);
export type RuntimeCapabilityName = z.infer<typeof RuntimeCapabilityNameSchema>;

export const HarnessCapabilityMatrixSchema = z
  .record(RuntimeCapabilityNameSchema, z.boolean())
  .readonly();
export type HarnessCapabilityMatrix = z.infer<
  typeof HarnessCapabilityMatrixSchema
>;

export function harnessCapabilityMatrix(
  capabilities: HarnessCapabilities,
): HarnessCapabilityMatrix {
  return HarnessCapabilityMatrixSchema.parse({
    persistent_threads: capabilities.persistentThreads,
    assistant_streaming: capabilities.assistantDeltas,
    tool_events: capabilities.toolEvents,
    usage_events: capabilities.usageEvents,
    interrupt: capabilities.interrupt,
    active_turn_steer: capabilities.steer,
    context_compaction: capabilities.compact,
    thread_recovery: capabilities.recover,
  });
}

const HarnessEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  harness: HarnessKindSchema,
  generation: z.number().int().nonnegative(),
  attempt: z.number().int().positive(),
  order: z.number().int().positive(),
  threadId: z.string().trim().min(1).nullable(),
  turnId: z.string().trim().min(1).nullable(),
  messageId: UuidSchema,
  sourceEventId: z.string().trim().min(1).max(240).optional(),
  sourceOccurredAt: z.string().datetime().optional(),
});

export const HarnessEventSchema = z.discriminatedUnion('type', [
  HarnessEventEnvelopeSchema.extend({
    type: z.literal('assistant.delta'),
    text: z.string(),
    orderStart: z.number().int().positive().optional(),
  }).strict(),
  HarnessEventEnvelopeSchema.extend({
    type: z.literal('assistant.completed'),
    text: z.string(),
  }).strict(),
  HarnessEventEnvelopeSchema.extend({
    type: z.enum(['tool.started', 'tool.completed', 'tool.failed']),
    toolCallId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    label: z.string().trim().min(1),
    source: z.enum(['harness', 'tool_broker']),
    summary: z.string().optional(),
    itemCount: z.number().int().nonnegative().optional(),
  }).strict(),
  HarnessEventEnvelopeSchema.extend({
    type: z.literal('usage.updated'),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict(),
]);
export type HarnessEvent = z.infer<typeof HarnessEventSchema>;

export const ContextCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkpointId: UuidSchema,
    sessionId: UuidSchema,
    harness: HarnessKindSchema,
    threadId: z.string().trim().min(1).nullable(),
    generation: z.number().int().nonnegative(),
    coveredThroughMessageId: UuidSchema.nullable(),
    summaryVersion: z.literal('extractive-v1'),
    summary: z.string(),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    estimatedTokens: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ContextCheckpoint = z.infer<typeof ContextCheckpointSchema>;

export const EmployeeKernelRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    harness: HarnessKindSchema,
    employeeAssignmentId: UuidSchema,
    employeeVersionId: UuidSchema,
    sessionId: UuidSchema,
    userMessageId: UuidSchema,
    assistantMessageId: UuidSchema,
    systemInstructions: z.string().min(1),
    userRequest: z.string(),
    bootstrapConversation: z.string(),
    authorizedMemoryContext: z.string(),
    grantedCapabilities: z.array(SkillCapabilitySchema),
    skillVersionIds: z.array(UuidSchema),
  })
  .strict();
export type EmployeeKernelRequest = z.infer<typeof EmployeeKernelRequestSchema>;
