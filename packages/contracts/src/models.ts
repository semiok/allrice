import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { HarnessKindSchema } from './harness.ts';

export const ModelReasoningEffortSchema = z.enum([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
]);
export type ModelReasoningEffort = z.infer<typeof ModelReasoningEffortSchema>;

export const ModelProviderAuthModeSchema = z.enum([
  'chatgpt_subscription',
  'api_key',
  'none',
]);
export type ModelProviderAuthMode = z.infer<typeof ModelProviderAuthModeSchema>;

export const ModelConnectionScopeSchema = z.enum(['platform', 'organization']);
export type ModelConnectionScope = z.infer<typeof ModelConnectionScopeSchema>;

export const ModelProviderSchema = z
  .object({
    id: UuidSchema,
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    harness: HarnessKindSchema,
    authMode: ModelProviderAuthModeSchema,
    enabled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelConnectionSchema = z
  .object({
    id: UuidSchema,
    providerId: UuidSchema,
    organizationId: UuidSchema.nullable(),
    scope: ModelConnectionScopeSchema,
    name: z.string().trim().min(1).max(120),
    credentialReference: z.string().trim().min(1).max(255).nullable(),
    baseUrl: z.string().url().max(2_000).nullable(),
    status: z.enum(['ready', 'degraded', 'disabled']),
    stability: z.enum(['production', 'experimental']),
    priority: z.number().int().min(0).max(10_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((connection, context) => {
    if (connection.scope === 'platform' && connection.organizationId) {
      context.addIssue({
        code: 'custom',
        path: ['organizationId'],
        message: 'platform connections cannot belong to an organization',
      });
    }
    if (connection.scope === 'organization' && !connection.organizationId) {
      context.addIssue({
        code: 'custom',
        path: ['organizationId'],
        message: 'organization connections require an organization',
      });
    }
  });
export type ModelConnection = z.infer<typeof ModelConnectionSchema>;

export const ModelCatalogEntrySchema = z
  .object({
    id: UuidSchema,
    providerId: UuidSchema,
    model: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(160),
    contextWindowTokens: z.number().int().positive().max(10_000_000).nullable(),
    reasoningEfforts: z.array(ModelReasoningEffortSchema).min(1).max(5),
    defaultReasoningEffort: ModelReasoningEffortSchema,
    inputModalities: z
      .array(z.enum(['text', 'image', 'audio', 'file']))
      .min(1)
      .max(4),
    outputModalities: z
      .array(z.enum(['text', 'image', 'audio', 'file']))
      .min(1)
      .max(4),
    enabled: z.boolean(),
    stability: z.enum(['production', 'experimental']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (!entry.reasoningEfforts.includes(entry.defaultReasoningEffort)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'default reasoning effort must be supported by the model',
      });
    }
  });
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ModelFallbackTargetSchema = z
  .object({
    connectionId: UuidSchema,
    modelCatalogEntryId: UuidSchema,
    reasoningEffort: ModelReasoningEffortSchema,
  })
  .strict();
export type ModelFallbackTarget = z.infer<typeof ModelFallbackTargetSchema>;

export const ResolvedModelTargetSchema = z
  .object({
    connectionId: UuidSchema,
    modelCatalogEntryId: UuidSchema,
    harness: HarnessKindSchema,
    provider: z.string().trim().min(1).max(120),
    authMode: ModelProviderAuthModeSchema,
    model: z.string().trim().min(1).max(200),
    reasoningEffort: ModelReasoningEffortSchema,
    credentialReference: z.string().trim().min(1).max(255).nullable(),
    baseUrl: z.string().url().max(2_000).nullable(),
  })
  .strict();
export type ResolvedModelTarget = z.infer<typeof ResolvedModelTargetSchema>;

export const EmployeeModelPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    employeeId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    connectionId: UuidSchema,
    modelCatalogEntryId: UuidSchema,
    reasoningEffort: ModelReasoningEffortSchema,
    fallbackPolicy: z.enum(['disabled', 'explicit']),
    fallbackTargets: z.array(ModelFallbackTargetSchema).max(8),
    revision: z.number().int().positive(),
    updatedBy: UuidSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      policy.fallbackPolicy === 'disabled' &&
      policy.fallbackTargets.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fallbackTargets'],
        message: 'disabled fallback policy cannot contain targets',
      });
    }
    if (
      policy.fallbackPolicy === 'explicit' &&
      policy.fallbackTargets.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fallbackTargets'],
        message: 'explicit fallback policy requires at least one target',
      });
    }
  });
export type EmployeeModelPolicy = z.infer<typeof EmployeeModelPolicySchema>;

export const SessionModelSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: UuidSchema,
    employeeId: UuidSchema,
    policyRevision: z.number().int().positive(),
    connectionId: UuidSchema,
    modelCatalogEntryId: UuidSchema,
    harness: HarnessKindSchema,
    provider: z.string().trim().min(1).max(120),
    authMode: ModelProviderAuthModeSchema,
    model: z.string().trim().min(1).max(200),
    reasoningEffort: ModelReasoningEffortSchema,
    credentialReference: z.string().trim().min(1).max(255).nullable(),
    baseUrl: z.string().url().max(2_000).nullable(),
    fallbackPolicy: z.enum(['disabled', 'explicit']),
    fallbackTargets: z.array(ModelFallbackTargetSchema).max(8),
    resolvedFallbacks: z.array(ResolvedModelTargetSchema).max(8).default([]),
    frozenAt: TimestampSchema,
  })
  .strict();
export type SessionModelSnapshot = z.infer<typeof SessionModelSnapshotSchema>;

export const UpsertEmployeeModelPolicyInputSchema = z
  .object({
    connectionId: UuidSchema,
    modelCatalogEntryId: UuidSchema,
    reasoningEffort: ModelReasoningEffortSchema,
    fallbackPolicy: z.enum(['disabled', 'explicit']).default('disabled'),
    fallbackTargets: z.array(ModelFallbackTargetSchema).max(8).default([]),
  })
  .strict();
export type UpsertEmployeeModelPolicyInput = z.infer<
  typeof UpsertEmployeeModelPolicyInputSchema
>;

export const UpsertModelConnectionInputSchema = z
  .object({
    providerId: UuidSchema,
    organizationId: UuidSchema.nullable().default(null),
    scope: ModelConnectionScopeSchema,
    name: z.string().trim().min(1).max(120),
    credentialReference: z.string().trim().min(1).max(255).nullable(),
    baseUrl: z.string().url().max(2_000).nullable(),
    status: z.enum(['ready', 'degraded', 'disabled']).default('ready'),
    stability: z.enum(['production', 'experimental']).default('production'),
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .strict();
export type UpsertModelConnectionInput = z.infer<
  typeof UpsertModelConnectionInputSchema
>;
