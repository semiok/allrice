import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import {
  CodexExecutionSnapshotSchema,
  SkillCapabilitySchema,
} from './skills.ts';

export const LegacyEmployeeProviderSchema = z
  .object({
    provider: z.literal('basic'),
    authMode: z.literal('none'),
    model: z.literal('allrice/basic-assistant-v1'),
    reasoningEffort: z.literal('none'),
    sandbox: z.literal('none'),
  })
  .strict();

export const EmployeeProviderSnapshotSchema = z.union([
  CodexExecutionSnapshotSchema,
  LegacyEmployeeProviderSchema,
]);

export const EmployeeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    systemPrompt: z.string().min(1).max(10_000),
    provider: EmployeeProviderSnapshotSchema,
    capabilities: z.array(SkillCapabilitySchema).max(16),
    skillVersionIds: z.array(UuidSchema).max(32),
  })
  .strict();
export type EmployeeManifest = z.infer<typeof EmployeeManifestSchema>;

export const EmployeeVersionSnapshotSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    version: z.number().int().positive(),
    manifest: EmployeeManifestSchema,
    configChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    publishedAt: TimestampSchema,
  })
  .strict();

export const EmployeeHubAssignmentSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    employeeKey: z.string().min(1),
    userId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    isDefault: z.boolean(),
    active: z.boolean(),
    currentVersion: EmployeeVersionSnapshotSchema,
    versions: z.array(EmployeeVersionSnapshotSchema),
  })
  .strict();

export const PublishEmployeeVersionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    skillVersionIds: z.array(UuidSchema).max(32).default([]),
  })
  .strict();

export const AssignEmployeeVersionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeVersionId: UuidSchema,
  })
  .strict();

export const SetDefaultEmployeeInputSchema = z
  .object({ workspaceId: UuidSchema })
  .strict();

export const EmployeeRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const EmployeePromptSnapshotSchema = z
  .object({
    systemPrompt: z.string().min(1).max(10_000),
    conversation: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'system', 'tool']),
            text: z.string().max(100_000),
          })
          .strict(),
      )
      .max(1_000),
    memories: z
      .array(
        z.object({ id: UuidSchema, content: z.string().max(100_000) }).strict(),
      )
      .max(20),
    userRequest: z.string().min(1).max(100_000),
  })
  .strict();

export const FrozenEmployeeSkillBindingSchema = z
  .object({
    installationId: UuidSchema,
    skillVersionId: UuidSchema,
    declaredCapabilities: z.array(SkillCapabilitySchema).max(16).default([]),
    grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
  })
  .strict();

export const EmployeeRunSchema = z
  .object({
    runId: UuidSchema,
    employeeAssignmentId: UuidSchema,
    employeeVersionId: UuidSchema,
    sessionId: UuidSchema,
    userMessageId: UuidSchema,
    assistantMessageId: UuidSchema,
    status: EmployeeRunStatusSchema,
    providerSnapshot: CodexExecutionSnapshotSchema,
    skillVersionIds: z.array(UuidSchema),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .strict();
