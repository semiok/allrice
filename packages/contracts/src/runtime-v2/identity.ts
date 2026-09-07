import { z } from 'zod';

import { TimestampSchema, UuidSchema } from '../common.ts';
import { ExecutionTargetKindSchema } from '../operations.ts';
import { ChecksumSchema } from '../runs.ts';

/** Product 2.0 contract revision; NOT RunEvent, ChatFlow or Bridge's version. */
export const RuntimeContractVersionSchema = z.literal(1);
export const RuntimeCounterSchema = z.number().int().nonnegative();

export const RuntimeScopeSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    projectId: UuidSchema.nullable(),
  })
  .strict();
export type RuntimeScope = z.infer<typeof RuntimeScopeSchema>;

/** References an existing Run and its frozen configuration; no new task ledger. */
export const RuntimeTaskRefSchema = z
  .object({
    scope: RuntimeScopeSchema,
    // ChatSession.id, NEVER the authentication RequestContext.sessionId.
    chatSessionId: UuidSchema.nullable(),
    runId: UuidSchema,
    rootRunId: UuidSchema,
    parentRunId: UuidSchema.nullable(),
    frozenConfiguration: z
      .object({
        employeeVersionId: UuidSchema.nullable(),
        digest: ChecksumSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((task, ctx) => {
    const isRoot = task.runId === task.rootRunId;
    if (
      isRoot !== (task.parentRunId === null) ||
      task.parentRunId === task.runId
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'inconsistent root/parent Run references',
      });
    }
  });
export type RuntimeTaskRef = z.infer<typeof RuntimeTaskRefSchema>;

/** Public fencing numbers, not secret JobLease.token or Bridge credentials. */
export const RuntimeAttemptRefSchema = z
  .object({
    operationId: UuidSchema,
    attemptId: UuidSchema,
    attemptNumber: z.number().int().positive(),
    generation: RuntimeCounterSchema,
    fence: z.number().int().positive(),
  })
  .strict();
export type RuntimeAttemptRef = z.infer<typeof RuntimeAttemptRefSchema>;

/** Long-lived targets keep their existing owner; this is an execution reference. */
export const RuntimeExecutionScopeSchema = z
  .object({
    targetId: UuidSchema,
    targetKind: ExecutionTargetKindSchema,
    deviceId: UuidSchema.nullable(),
    grantId: UuidSchema,
    grantVersion: z.number().int().positive(),
    scopeDigest: ChecksumSchema,
    workCopy: z
      .object({
        id: UuidSchema,
        kind: z.enum(['in_place', 'git_worktree', 'cloud_copy']),
      })
      .strict(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if ((scope.targetKind === 'rice_bridge') !== (scope.deviceId !== null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'only Bridge scopes require a device reference',
      });
    }
  });
export type RuntimeExecutionScope = z.infer<typeof RuntimeExecutionScopeSchema>;

/** Reuses Artifact/StorageObject/DeliverableVersion identities, not a new asset store. */
export const RuntimeContentRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('artifact'),
      id: UuidSchema,
      checksum: ChecksumSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('storage_object'),
      id: UuidSchema,
      checksum: ChecksumSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('deliverable_version'),
      id: UuidSchema,
      objectId: UuidSchema,
      seriesId: UuidSchema,
      version: z.number().int().positive(),
      checksum: ChecksumSchema,
    })
    .strict(),
]);
export type RuntimeContentRef = z.infer<typeof RuntimeContentRefSchema>;

/** Provenance plus the separately resolved transfer authorization, not a grant itself. */
export const RuntimeDataScopeSchema = z
  .object({
    content: RuntimeContentRefSchema,
    sourceTargetId: UuidSchema.nullable(),
    purpose: z.enum(['model_context', 'execution_input', 'delivery']),
    destination: z.enum([
      'in_place',
      'cloud_model',
      'cloud_execution',
      'local_write',
    ]),
    authorizationId: UuidSchema,
    authorizationVersion: z.number().int().positive(),
  })
  .strict();
export type RuntimeDataScope = z.infer<typeof RuntimeDataScopeSchema>;

/** Only digests cross the approval/event boundary; no raw env, argv secrets or paths. */
export const RuntimeCommandBindingSchema = z
  .object({
    executableDigest: ChecksumSchema,
    argumentsDigest: ChecksumSchema,
    workingDirectoryDigest: ChecksumSchema,
    effectiveEnvironmentDigest: ChecksumSchema,
    networkPolicyDigest: ChecksumSchema,
    toolchainDigest: ChecksumSchema,
    budgetDigest: ChecksumSchema,
  })
  .strict();

export const RuntimeActionBindingSchema = z
  .object({
    task: RuntimeTaskRefSchema,
    attempt: RuntimeAttemptRefSchema,
    requestedBy: z
      .object({ type: z.enum(['user', 'service']), id: UuidSchema })
      .strict(),
    policy: z
      .object({ snapshotId: UuidSchema, digest: ChecksumSchema })
      .strict(),
    execution: RuntimeExecutionScopeSchema,
    action: z.string().trim().min(1).max(160),
    inputDigest: ChecksumSchema,
    dataScope: z.array(RuntimeDataScopeSchema).max(128),
    baseline: z.array(RuntimeContentRefSchema).max(256),
    command: RuntimeCommandBindingSchema.nullable(),
  })
  .strict();
export type RuntimeActionBinding = z.infer<typeof RuntimeActionBindingSchema>;

export const RuntimeEvidenceRefSchema = z
  .object({
    id: UuidSchema,
    recordedAt: TimestampSchema,
    digest: ChecksumSchema,
  })
  .strict();

/** Equality only: callers must parse and resolve IDs against trusted state first. */
export function runtimeContractEqual(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Ownership precondition only. Does NOT authorize memberships, visibility or grants. */
export function matchesRuntimeScope(
  actual: RuntimeScope,
  trusted: RuntimeScope,
): boolean {
  return runtimeContractEqual(
    RuntimeScopeSchema.parse(actual),
    RuntimeScopeSchema.parse(trusted),
  );
}
