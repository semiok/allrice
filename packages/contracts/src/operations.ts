import { z } from 'zod';

import { TimestampSchema, UuidSchema, VisibilitySchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const MemoryTrustSchema = z.enum([
  'user_confirmed',
  'platform_verified',
  'derived',
  'untrusted_external',
]);
export type MemoryTrust = z.infer<typeof MemoryTrustSchema>;

export const MemoryLifecycleStateSchema = z.enum(['candidate', 'durable']);
export type MemoryLifecycleState = z.infer<typeof MemoryLifecycleStateSchema>;

export const MemoryClassSchema = z.enum([
  'user_preference',
  'project_fact',
  'decision',
  'work_note',
]);
export type MemoryClass = z.infer<typeof MemoryClassSchema>;

export const MemorySourceTypeSchema = z.enum([
  'user',
  'message',
  'file',
  'tool',
  'connector',
  'checkpoint',
]);
export type MemorySourceType = z.infer<typeof MemorySourceTypeSchema>;

export const MemoryProvenanceSchema = z
  .object({
    sourceType: MemorySourceTypeSchema,
    sourceId: UuidSchema.nullable(),
    sourceLabel: z.string().trim().min(1).max(240),
    trust: MemoryTrustSchema,
    confidence: z.number().min(0).max(1),
    capturedAt: TimestampSchema,
  })
  .strict();

export const GovernedMemorySchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    employeeId: UuidSchema.nullable(),
    ownerId: UuidSchema,
    content: z.string().min(1).max(100_000),
    visibility: VisibilitySchema,
    lifecycleState: MemoryLifecycleStateSchema,
    memoryClass: MemoryClassSchema,
    revision: z.number().int().positive(),
    provenance: MemoryProvenanceSchema,
    expiresAt: TimestampSchema.nullable(),
    lastVerifiedAt: TimestampSchema.nullable(),
    supersedesMemoryId: UuidSchema.nullable(),
    lastRecalledAt: TimestampSchema.nullable(),
    recallCount: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    archivedAt: TimestampSchema.nullable(),
  })
  .strict();
export type GovernedMemory = z.infer<typeof GovernedMemorySchema>;

export const MemoryRevisionSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    memoryId: UuidSchema,
    revision: z.number().int().positive(),
    content: z.string().min(1).max(100_000),
    trust: MemoryTrustSchema,
    lifecycleState: MemoryLifecycleStateSchema,
    memoryClass: MemoryClassSchema,
    confidence: z.number().min(0).max(1),
    expiresAt: TimestampSchema.nullable(),
    reason: z.string().min(1).max(500),
    changedBy: UuidSchema,
    changedAt: TimestampSchema,
  })
  .strict();
export type MemoryRevision = z.infer<typeof MemoryRevisionSchema>;

export const CorrectMemoryInputSchema = z
  .object({
    content: z.string().trim().min(1).max(100_000),
    reason: z.string().trim().min(1).max(500),
    confidence: z.number().min(0).max(1).default(1),
    expiresAt: TimestampSchema.nullable().default(null),
  })
  .strict();

export const CreateCheckpointMemoryCandidateInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    sessionId: UuidSchema,
    checkpointId: UuidSchema,
    content: z.string().trim().min(1).max(100_000),
    sourceLabel: z.string().trim().min(1).max(240),
  })
  .strict();

export const ExecutionTargetKindSchema = z.enum([
  'cloud_sandbox',
  'rice_bridge',
]);
export type ExecutionTargetKind = z.infer<typeof ExecutionTargetKindSchema>;

export const ExecutionTargetStateSchema = z.enum([
  'online',
  'degraded',
  'offline',
  'revoked',
]);

export const ExecutionTargetCapabilitySchema = z.enum([
  'files.read',
  'files.write',
  'git.read',
  'git.write',
  'process.execute',
  'browser.navigate',
  'browser.download',
  'artifacts.write',
]);
export type ExecutionTargetCapability = z.infer<
  typeof ExecutionTargetCapabilitySchema
>;

export const ExecutionTargetSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    kind: ExecutionTargetKindSchema,
    label: z.string().trim().min(1).max(160),
    state: ExecutionTargetStateSchema,
    capabilities: z.array(ExecutionTargetCapabilitySchema),
    concurrencyLimit: z.number().int().min(1).max(100),
    timeoutSeconds: z.number().int().min(1).max(86_400),
    lastHeartbeatAt: TimestampSchema.nullable(),
    unavailableReason: z.string().max(500).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;

export const RegisterExecutionTargetInputSchema = z
  .object({
    workspaceId: UuidSchema,
    targetKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
      .max(120),
    kind: ExecutionTargetKindSchema,
    label: z.string().trim().min(1).max(160),
    capabilities: z.array(ExecutionTargetCapabilitySchema).min(1),
    concurrencyLimit: z.number().int().min(1).max(100).default(1),
    timeoutSeconds: z.number().int().min(1).max(86_400).default(900),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const ManagedBrowserTaskStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

/**
 * Deliberately small, read-only browser instruction set. The runtime may
 * translate these steps to its native browser driver, but it must not accept
 * arbitrary JavaScript, form submission, credential entry, or shell commands.
 */
export const ManagedBrowserStepSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('wait_for'),
      selector: z.string().trim().min(1).max(1_000),
      timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('follow_link'),
      selector: z.string().trim().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('scroll'),
      direction: z.enum(['up', 'down']).default('down'),
      distancePx: z.number().int().min(1).max(20_000).default(1_000),
    })
    .strict(),
]);
export type ManagedBrowserStep = z.infer<typeof ManagedBrowserStepSchema>;

export const ManagedBrowserEvidenceEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    kind: z.enum(['navigation', 'interaction', 'capture', 'download']),
    status: z.enum(['succeeded', 'failed', 'canceled']),
    label: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1_000),
    occurredAt: TimestampSchema,
    url: z.string().url().nullable().default(null),
  })
  .strict();
export type ManagedBrowserEvidenceEvent = z.infer<
  typeof ManagedBrowserEvidenceEventSchema
>;

export const ManagedBrowserEvidenceSchema = z
  .object({
    url: z.string().url(),
    title: z.string().max(500).nullable(),
    capturedAt: TimestampSchema,
    contentChecksum: ChecksumSchema,
    contentObjectId: UuidSchema.nullable().default(null),
    screenshotObjectId: UuidSchema.nullable(),
    downloadObjectIds: z.array(UuidSchema),
    events: z.array(ManagedBrowserEvidenceEventSchema).max(200).default([]),
  })
  .strict();
export type ManagedBrowserEvidence = z.infer<
  typeof ManagedBrowserEvidenceSchema
>;

export const ManagedBrowserEvidenceArtifactSchema = z
  .object({
    id: UuidSchema,
    objectId: UuidSchema,
    kind: z.enum(['content', 'screenshot', 'download']),
    name: z.string().trim().min(1).max(255),
    checksum: ChecksumSchema,
    mediaType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();
export type ManagedBrowserEvidenceArtifact = z.infer<
  typeof ManagedBrowserEvidenceArtifactSchema
>;

export const ManagedBrowserTaskSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    runId: UuidSchema,
    targetId: UuidSchema,
    status: ManagedBrowserTaskStatusSchema,
    startUrl: z.string().url(),
    allowedDomains: z.array(z.string().min(1).max(253)).min(1),
    steps: z.array(ManagedBrowserStepSchema).max(50).default([]),
    evidence: z.array(ManagedBrowserEvidenceSchema),
    artifacts: z
      .array(ManagedBrowserEvidenceArtifactSchema)
      .max(500)
      .default([]),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable().default(null),
    cancelRequestedAt: TimestampSchema.nullable().default(null),
    errorCode: z.string().max(160).nullable().default(null),
    completedAt: TimestampSchema.nullable(),
  })
  .strict();
export type ManagedBrowserTask = z.infer<typeof ManagedBrowserTaskSchema>;

export const ExternalActionRiskSchema = z.enum([
  'managed_write',
  'external_send',
  'destructive',
  'financial_or_legal',
]);

export const ExternalActionStatusSchema = z.enum([
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'succeeded',
  'failed',
  'canceled',
]);

export const ExternalActionSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    runId: UuidSchema,
    actorId: UuidSchema,
    targetId: UuidSchema.nullable(),
    connectorBindingId: UuidSchema.nullable(),
    action: z.string().trim().min(1).max(160),
    risk: ExternalActionRiskSchema,
    status: ExternalActionStatusSchema,
    inputDigest: ChecksumSchema,
    outputDigest: ChecksumSchema.nullable(),
    approvalId: UuidSchema.nullable(),
    idempotencyKey: z.string().trim().min(1).max(255),
    errorCode: z.string().max(160).nullable(),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
  })
  .strict();

export const DeliveryFormatSchema = z.enum([
  'markdown',
  'text',
  'html',
  'json',
  'docx',
  'xlsx',
  'pptx',
  'pdf',
]);
export type DeliveryFormat = z.infer<typeof DeliveryFormatSchema>;

export const DeliverableVersionSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    objectId: UuidSchema,
    seriesId: UuidSchema,
    version: z.number().int().positive(),
    parentVersionId: UuidSchema.nullable(),
    parentObjectId: UuidSchema.nullable(),
    sessionId: UuidSchema.nullable(),
    platformTestRunId: UuidSchema.nullable(),
    fileName: z.string().trim().min(1).max(255),
    format: DeliveryFormatSchema,
    changeSummary: z.string().max(2_000).nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
export type DeliverableVersion = z.infer<typeof DeliverableVersionSchema>;
