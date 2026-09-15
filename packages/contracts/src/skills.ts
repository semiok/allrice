import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillBundleSchema } from './skill-bundle.ts';
import { CodexSubscriptionQuotaSnapshotSchema } from './codex-subscription-quota.ts';

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

// Provenance remains part of the generic capability contract. DSH-native
// skills use it in the administration plane, without reintroducing a catalog
// or tenant installation lifecycle.
export const SkillSourceSchema = z
  .object({
    repository: z.string().url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1).max(512),
    license: z.string().min(1).max(120),
  })
  .strict();

export const DshNativeSkillSnapshotSchema = z
  .object({
    id: UuidSchema,
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(500),
    content: z.string().max(500_000),
    checksum: ChecksumSchema,
    invocation: z
      .object({
        modelInvocable: z.boolean(),
        userInvocable: z.boolean(),
      })
      .strict(),
    requiredToolRefs: z.array(z.string().trim().min(1).max(240)).max(32),
    // Deliberately optional without a default: v1 persisted checksums must not change.
    bundle: SkillBundleSchema.optional(),
  })
  .strict();
export type DshNativeSkillSnapshot = z.infer<
  typeof DshNativeSkillSnapshotSchema
>;

export const CodexProviderStatusSchema = z
  .object({
    provider: z.literal('codex'),
    authMode: z.literal('chatgpt_subscription'),
    status: z.enum(['connected', 'disconnected', 'error', 'unknown']),
    cliVersion: z.string().max(120).nullable(),
    detailCode: z.string().max(120).nullable(),
    checkedAt: TimestampSchema.nullable(),
    quota: CodexSubscriptionQuotaSnapshotSchema.nullable().optional(),
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
    authMode: z.enum(['allrice_credential', 'platform_subscription']),
    route: z.enum([
      'openai-codex',
      'gemini',
      'deepseek-official',
      'openai-compatible',
    ]),
    model: z.string().min(1).max(200),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
    credentialReference: z.string().min(1).max(255),
    baseUrl: z.string().url().max(2_000).nullable(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      snapshot.route === 'openai-codex' &&
      snapshot.authMode !== 'platform_subscription'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authMode'],
        message: 'OpenAI Codex is a platform subscription Provider in DSH',
      });
    }
    // Historical Gemini snapshots incorrectly said platform_subscription.
    // Accept them for immutable history; execution still requires a separately
    // enabled API adapter and a deployment/tenant-scoped credential resolver.
    if (
      snapshot.route !== 'openai-codex' &&
      snapshot.route !== 'gemini' &&
      snapshot.authMode !== 'allrice_credential'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['authMode'],
        message: 'API Providers require an AllRice credential',
      });
    }
  });
export type DshExecutionSnapshot = z.infer<typeof DshExecutionSnapshotSchema>;

export const HarnessExecutionSnapshotSchema = z.union([
  CodexExecutionSnapshotSchema,
  DshExecutionSnapshotSchema,
]);
export type HarnessExecutionSnapshot = z.infer<
  typeof HarnessExecutionSnapshotSchema
>;
