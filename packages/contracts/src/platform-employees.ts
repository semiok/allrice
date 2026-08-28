import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const PlatformEmployeeStatusSchema = z.enum([
  'draft',
  'testing',
  'published',
  'disabled',
  'archived',
]);

export const PlatformEmployeeRevisionStatusSchema = z.enum([
  'draft',
  'testing',
  'published',
  'disabled',
]);

export const PlatformEmployeeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    appearance: z
      .object({
        avatarType: z.enum(['initials', 'emoji', 'image']),
        avatarValue: z.string().trim().min(1).max(500),
      })
      .strict(),
    identity: z
      .object({
        role: z.string().trim().min(1).max(120),
        mission: z.string().trim().min(1).max(500),
        workStyle: z.string().trim().min(1).max(1_000),
        behaviorRules: z.array(z.string().trim().min(1).max(500)).max(32),
        safetyBoundaries: z.array(z.string().trim().min(1).max(500)).max(32),
        expressionStyle: z.enum(['concise', 'structured', 'exploratory']),
        outputLanguage: z.enum(['zh-CN', 'en-US']),
      })
      .strict(),
    systemPrompt: z.string().trim().min(1).max(20_000),
    modelPolicy: z
      .object({
        provider: z.enum([
          'openai-codex',
          'deepseek-official',
          'openai-compatible',
        ]),
        model: z.string().trim().min(1).max(200),
        reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
        timeoutMs: z.number().int().min(1_000).max(3_600_000),
        fallbackModels: z.array(z.string().trim().min(1).max(200)).max(8),
        credentialReference: z.string().trim().min(1).max(255),
        baseUrl: z.string().url().max(2_000).nullable(),
      })
      .strict(),
    capabilities: z
      .object({
        nativeSkillIds: z.array(UuidSchema).max(64),
        workflowRevisionIds: z.array(UuidSchema).max(32),
        knowledgeRevisionIds: z.array(UuidSchema).max(32),
        toolNames: z.array(z.string().trim().min(1).max(160)).max(64),
        connectorRefs: z.array(z.string().trim().min(1).max(200)).max(32),
      })
      .strict(),
    securityPolicy: z
      .object({
        dataScopes: z
          .array(z.enum(['organization', 'workspace', 'employee', 'user']))
          .max(4),
        approvalPolicy: z.enum([
          'confirm_side_effects',
          'confirm_external',
          'autonomous',
        ]),
        bridgeAccess: z.enum(['none', 'read_only']),
        connectorIdentityModes: z.array(z.enum(['user', 'service'])).max(2),
        deniedCapabilities: z
          .array(
            z.enum([
              'network:outbound',
              'storage:read',
              'storage:write',
              'secret:use',
              'model:invoke',
              'automation:write',
            ]),
          )
          .max(16),
      })
      .strict(),
  })
  .strict();

export type PlatformEmployeeDefinition = z.infer<
  typeof PlatformEmployeeDefinitionSchema
>;

export const PlatformEmployeeRuntimeProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    harness: z.literal('dsh'),
    employeeKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
    credentialReference: z.string().trim().min(1).max(255),
    systemPrompt: z.string().trim().min(1).max(30_000),
    nativeSkillIds: z.array(UuidSchema).max(64),
    nativeSkillChecksums: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)),
    toolNames: z.array(z.string().trim().min(1).max(160)).max(64),
    connectorRefs: z.array(z.string().trim().min(1).max(200)).max(32),
    securityPolicy: PlatformEmployeeDefinitionSchema.shape.securityPolicy,
  })
  .strict();

export const PlatformEmployeeRevisionSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    revision: z.number().int().positive(),
    status: PlatformEmployeeRevisionStatusSchema,
    definition: PlatformEmployeeDefinitionSchema,
    runtimeProfile: PlatformEmployeeRuntimeProfileSchema.nullable(),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    createdAt: TimestampSchema,
    publishedAt: TimestampSchema.nullable(),
  })
  .strict();

export const PlatformEmployeeSummarySchema = z
  .object({
    id: UuidSchema,
    employeeKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    status: PlatformEmployeeStatusSchema,
    currentDraft: PlatformEmployeeRevisionSchema.nullable(),
    currentPublished: PlatformEmployeeRevisionSchema.nullable(),
    assignedWorkspaceIds: z.array(UuidSchema),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export type PlatformEmployeeSummary = z.infer<
  typeof PlatformEmployeeSummarySchema
>;

export const UpdatePlatformEmployeeInputSchema = z
  .object({
    definition: PlatformEmployeeDefinitionSchema,
  })
  .strict();

export const PublishPlatformEmployeeInputSchema = z
  .object({
    workspaceIds: z.array(UuidSchema).min(1).max(500),
  })
  .strict();
