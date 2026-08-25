import { z } from 'zod';

import {
  WorkflowDefinitionSchema,
  WorkflowStepKindSchema,
} from './capabilities.ts';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const WorkflowRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'canceled',
  'needs_attention',
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const WorkflowStepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'skipped',
  'compensating',
  'compensated',
  'needs_attention',
]);
export type WorkflowStepStatus = z.infer<typeof WorkflowStepStatusSchema>;

export const WorkflowStepRunSchema = z
  .object({
    id: UuidSchema,
    workflowRunId: UuidSchema,
    stepKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    name: z.string().min(1).max(120),
    kind: WorkflowStepKindSchema,
    status: WorkflowStepStatusSchema,
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    inputDigest: ChecksumSchema.nullable(),
    outputDigest: ChecksumSchema.nullable(),
    output: z.unknown().nullable(),
    idempotencyKey: z.string().min(1).max(255),
    approvalId: UuidSchema.nullable(),
    sideEffectCommitted: z.boolean(),
    checkpoint: z.record(z.string(), z.unknown()),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .strict();
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;

export const WorkflowRunSchema = z
  .object({
    id: UuidSchema,
    runId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    employeeId: UuidSchema,
    workflowRevisionId: UuidSchema,
    sessionId: UuidSchema.nullable(),
    status: WorkflowRunStatusSchema,
    definition: WorkflowDefinitionSchema,
    input: z.unknown(),
    output: z.unknown().nullable(),
    currentStepKey: z.string().nullable(),
    checkpoint: z.record(z.string(), z.unknown()),
    steps: z.array(WorkflowStepRunSchema),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .strict();
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const StartWorkflowRunInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    workflowRevisionId: UuidSchema,
    sessionId: UuidSchema.nullable().default(null),
    input: z.unknown(),
    idempotencyKey: z.string().trim().min(1).max(255),
  })
  .strict();
export type StartWorkflowRunInput = z.infer<typeof StartWorkflowRunInputSchema>;

export const DecideWorkflowApprovalInputSchema = z
  .object({
    workspaceId: UuidSchema,
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const WorkflowArtifactSchema = z
  .object({
    id: UuidSchema,
    workflowRunId: UuidSchema,
    stepKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    storageObjectId: UuidSchema,
    name: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(255),
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict();

export const WorkflowEvaluationSchema = z
  .object({
    routingAccuracy: z.number().min(0).max(1),
    citationAccuracy: z.number().min(0).max(1),
    approvalHitRate: z.number().min(0).max(1),
    recoverySuccessRate: z.number().min(0).max(1),
    sideEffectDuplicateCount: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costCents: z.number().int().nonnegative(),
  })
  .strict();
