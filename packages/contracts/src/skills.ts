import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

export const SkillCapabilitySchema = z.enum([
  'network:outbound',
  'storage:read',
  'storage:write',
  'secret:use',
  'model:invoke',
  'automation:write',
]);
export type SkillCapability = z.infer<typeof SkillCapabilitySchema>;

export const AgentSkillRiskLevelSchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
]);

export const AgentSkillMetadataSchema = z
  .object({
    applicableScenarios: z
      .array(z.string().trim().min(1).max(300))
      .max(24)
      .default([]),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    requiredToolRefs: z
      .array(z.string().trim().min(1).max(240))
      .max(32)
      .default([]),
    riskLevel: AgentSkillRiskLevelSchema.default('low'),
  })
  .strict();
export type AgentSkillMetadata = z.infer<typeof AgentSkillMetadataSchema>;

export const SkillSourceSchema = z
  .object({
    repository: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1).max(512),
    license: z.string().min(1).max(120),
  })
  .strict();

export const SkillArtifactFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !path.includes('\\') &&
          !path.split('/').includes('..'),
        'skill file path must be relative and cannot traverse directories',
      ),
    content: z.string().max(500_000),
  })
  .strict();

export const SkillArtifactBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    entrypoint: z.literal('SKILL.md'),
    files: z
      .array(SkillArtifactFileSchema)
      .min(1)
      .max(64)
      .refine(
        (files) =>
          files.some((file) => file.path === 'SKILL.md') &&
          new Set(files.map((file) => file.path)).size === files.length,
        'skill bundle needs one unique SKILL.md entrypoint',
      ),
  })
  .strict();
export type SkillArtifactBundle = z.infer<typeof SkillArtifactBundleSchema>;

export const CatalogSkillSchema = z
  .object({
    id: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    publisher: z.string().min(1).max(120),
  })
  .strict();

export const SkillVersionSchema = z
  .object({
    id: UuidSchema,
    catalogSkillId: UuidSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    status: z.enum(['draft', 'published', 'deprecated', 'revoked']),
    capabilities: z.array(SkillCapabilitySchema),
    compatibility: z.object({ api: z.literal('v1') }).strict(),
    publishedAt: TimestampSchema.nullable(),
  })
  .strict();

export const SkillArtifactSchema = z
  .object({
    id: UuidSchema,
    skillVersionId: UuidSchema,
    checksum: ChecksumSchema,
    objectKey: z.string().min(1).max(1024),
    sizeBytes: z.number().int().positive(),
    source: SkillSourceSchema,
  })
  .strict();

export const ImportSkillInputSchema = z
  .object({
    workspaceId: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    publisher: z.string().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    capabilities: z.array(SkillCapabilitySchema).max(16),
    agentMetadata: AgentSkillMetadataSchema.default({
      applicableScenarios: [],
      inputSchema: {},
      outputSchema: {},
      requiredToolRefs: [],
      riskLevel: 'low',
    }),
    source: SkillSourceSchema,
    bundle: SkillArtifactBundleSchema,
  })
  .strict();
export type ImportSkillInput = z.infer<typeof ImportSkillInputSchema>;

export const InstallSkillInputSchema = z
  .object({
    workspaceId: UuidSchema,
    skillVersionId: UuidSchema,
    scope: z.enum(['personal', 'workspace']).default('personal'),
    grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    budgetCents: z.number().int().nonnegative().max(1_000_000).default(0),
  })
  .strict();

export const UpdateSkillInstallationInputSchema = z
  .object({
    workspaceId: UuidSchema,
    enabled: z.boolean().optional(),
    favorite: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => input.enabled !== undefined || input.favorite !== undefined,
    'an installation update is required',
  );

export const ExecuteSkillInputSchema = z
  .object({
    workspaceId: UuidSchema,
    installationId: UuidSchema,
    prompt: z.string().min(1).max(100_000),
    idempotencyKey: z.string().min(1).max(255),
  })
  .strict();

export const CodexProviderStatusSchema = z
  .object({
    provider: z.literal('codex'),
    authMode: z.literal('chatgpt_subscription'),
    status: z.enum(['connected', 'disconnected', 'error', 'unknown']),
    cliVersion: z.string().max(120).nullable(),
    detailCode: z.string().max(120).nullable(),
    checkedAt: TimestampSchema.nullable(),
  })
  .strict();
export type CodexProviderStatus = z.infer<typeof CodexProviderStatusSchema>;

export const CodexExecutionSnapshotSchema = z
  .object({
    provider: z.literal('codex'),
    authMode: z.literal('chatgpt_subscription'),
    model: z.string().min(1).max(120),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    sandbox: z.literal('workspace-write'),
  })
  .strict();
export type CodexExecutionSnapshot = z.infer<
  typeof CodexExecutionSnapshotSchema
>;

export const DshExecutionSnapshotSchema = z
  .object({
    provider: z.literal('dsh'),
    authMode: z.literal('allrice_credential'),
    route: z.enum(['deepseek-official', 'openai-compatible']),
    model: z.string().min(1).max(200),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
    credentialReference: z.string().min(1).max(255),
    baseUrl: z.string().url().max(2_000).nullable(),
  })
  .strict();
export type DshExecutionSnapshot = z.infer<typeof DshExecutionSnapshotSchema>;

export const HarnessExecutionSnapshotSchema = z.union([
  CodexExecutionSnapshotSchema,
  DshExecutionSnapshotSchema,
]);
export type HarnessExecutionSnapshot = z.infer<
  typeof HarnessExecutionSnapshotSchema
>;

export const SkillInstallationSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema.nullable(),
    catalogSkillId: UuidSchema,
    pinnedVersionId: UuidSchema.nullable(),
    enabled: z.boolean(),
    favorite: z.boolean(),
    grantedCapabilities: z.array(SkillCapabilitySchema),
    timeoutMs: z.number().int().positive().max(3_600_000),
    budgetCents: z.number().int().nonnegative(),
  })
  .strict();
