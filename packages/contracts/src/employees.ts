import { z } from 'zod';

import {
  FrozenAgentSkillBindingSchema,
  FrozenKnowledgeBindingSchema,
  FrozenWorkflowBindingSchema,
} from './capabilities.ts';
import { TimestampSchema, UuidSchema } from './common.ts';
import { SessionModelSnapshotSchema } from './models.ts';
import { PromptImageAttachmentSchema } from './storage.ts';
import {
  CodexExecutionSnapshotSchema,
  DshExecutionSnapshotSchema,
  HarnessExecutionSnapshotSchema,
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
  DshExecutionSnapshotSchema,
  LegacyEmployeeProviderSchema,
]);

export const PartnerProfileSchema = z
  .object({
    role: z.string().trim().min(1).max(120),
    mission: z.string().trim().min(1).max(500),
    communicationStyle: z.enum(['concise', 'structured', 'exploratory']),
    outputLanguage: z.enum(['zh-CN', 'en-US']),
    proactivePolicy: z.enum(['suggest', 'ask', 'disabled']),
    approvalPolicy: z
      .enum(['confirm_side_effects', 'confirm_external', 'autonomous'])
      .default('confirm_side_effects'),
  })
  .strict();
export type PartnerProfile = z.infer<typeof PartnerProfileSchema>;

export const DefaultPartnerProfile: PartnerProfile = {
  role: '通用工作伙伴',
  mission: '理解目标、推进任务，并交付可继续协作的结果。',
  communicationStyle: 'structured',
  outputLanguage: 'zh-CN',
  proactivePolicy: 'suggest',
  approvalPolicy: 'confirm_side_effects',
};

export const EmployeeAppearanceSchema = z
  .object({
    avatarType: z.enum(['initials', 'emoji', 'image']).default('initials'),
    avatarValue: z.string().trim().min(1).max(500).default('R'),
  })
  .strict();

export const EmployeeIdentitySchema = z
  .object({
    role: z.string().trim().min(1).max(120),
    mission: z.string().trim().min(1).max(500),
    workStyle: z.string().trim().min(1).max(1_000),
    behaviorRules: z.array(z.string().trim().min(1).max(500)).max(32),
    safetyBoundaries: z.array(z.string().trim().min(1).max(500)).max(32),
  })
  .strict();
export type EmployeeIdentity = z.infer<typeof EmployeeIdentitySchema>;

export const EmployeeRuntimePolicySchema = z
  .object({
    harness: z.enum(['codex', 'dsh']),
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']),
    timeoutMs: z.number().int().min(1_000).max(3_600_000),
    fallbackModels: z.array(z.string().trim().min(1).max(200)).max(8),
    credentialReference: z.string().trim().min(1).max(255).optional(),
    baseUrl: z.string().url().max(2_000).nullable().optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.harness === 'codex') {
      if (policy.provider !== 'codex' || policy.reasoningEffort === 'none') {
        context.addIssue({
          code: 'custom',
          message:
            'Legacy Codex Harness policies are read-only and normalized to DSH at execution',
        });
      }
      return;
    }
    if (
      policy.provider !== 'openai-codex' &&
      policy.provider !== 'deepseek-official' &&
      policy.provider !== 'openai-compatible'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'DSH requires a supported provider route',
      });
    }
    if (!policy.credentialReference) {
      context.addIssue({
        code: 'custom',
        path: ['credentialReference'],
        message: 'DSH requires an AllRice credential reference',
      });
    }
    if (policy.provider === 'openai-compatible' && !policy.baseUrl) {
      context.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'OpenAI-compatible DSH routes require a base URL',
      });
    }
  });
export type EmployeeRuntimePolicy = z.infer<typeof EmployeeRuntimePolicySchema>;

export const EmployeeCapabilityBindingsSchema = z
  .object({
    skillVersionIds: z.array(UuidSchema).max(32),
    toolNames: z.array(z.string().trim().min(1).max(160)).max(64),
    knowledgeScopes: z
      .array(z.enum(['organization', 'workspace', 'employee', 'user']))
      .max(4),
    workflowIds: z.array(UuidSchema).max(32),
  })
  .strict();

export const EmployeeSecurityPolicySchema = z
  .object({
    dataScopes: z
      .array(z.enum(['organization', 'workspace', 'employee', 'user']))
      .max(4),
    connectorIdentityModes: z.array(z.enum(['user', 'service'])).max(2),
    approvalPolicy: z.enum([
      'confirm_side_effects',
      'confirm_external',
      'autonomous',
    ]),
    deniedCapabilities: z.array(SkillCapabilitySchema).max(16),
  })
  .strict();
export type EmployeeSecurityPolicy = z.infer<
  typeof EmployeeSecurityPolicySchema
>;

export const EmployeeUserProfilePolicySchema = z
  .object({
    enabled: z.boolean(),
    fields: z.array(z.enum(['displayName', 'preferences'])).max(2),
    scope: z.literal('employee_user'),
  })
  .strict();
export type EmployeeUserProfilePolicy = z.infer<
  typeof EmployeeUserProfilePolicySchema
>;

const EmployeeManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    systemPrompt: z.string().min(1).max(10_000),
    provider: EmployeeProviderSnapshotSchema,
    capabilities: z.array(SkillCapabilitySchema).max(16),
    skillVersionIds: z.array(UuidSchema).max(32),
    partnerProfile: PartnerProfileSchema.default(DefaultPartnerProfile),
  })
  .strict();

export const EmployeeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(2),
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    appearance: EmployeeAppearanceSchema,
    applicableScenarios: z.array(z.string().trim().min(1).max(300)).max(24),
    isDefaultRice: z.boolean(),
    identity: EmployeeIdentitySchema,
    systemPrompt: z.string().min(1).max(10_000),
    provider: EmployeeProviderSnapshotSchema,
    runtimePolicy: EmployeeRuntimePolicySchema,
    capabilities: z.array(SkillCapabilitySchema).max(16),
    skillVersionIds: z.array(UuidSchema).max(32),
    capabilityBindings: EmployeeCapabilityBindingsSchema,
    securityPolicy: EmployeeSecurityPolicySchema,
    userProfilePolicy: EmployeeUserProfilePolicySchema.default({
      enabled: true,
      fields: ['displayName', 'preferences'],
      scope: 'employee_user',
    }),
    partnerProfile: PartnerProfileSchema.default(DefaultPartnerProfile),
  })
  .strict()
  .superRefine((definition, context) => {
    const topLevel = [...new Set(definition.skillVersionIds)].sort();
    const bindings = [
      ...new Set(definition.capabilityBindings.skillVersionIds),
    ].sort();
    if (JSON.stringify(topLevel) !== JSON.stringify(bindings)) {
      context.addIssue({
        code: 'custom',
        path: ['capabilityBindings', 'skillVersionIds'],
        message: 'skill bindings must match skillVersionIds',
      });
    }
  });

export const EmployeeManifestSchema = z.union([
  EmployeeDefinitionSchema,
  EmployeeManifestV1Schema,
]);
export type EmployeeManifest = z.infer<typeof EmployeeManifestSchema>;
export type EmployeeDefinition = z.infer<typeof EmployeeDefinitionSchema>;

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
    assignedBy: UuidSchema.nullable(),
    assignedAt: TimestampSchema,
    memoryCount: z.number().int().nonnegative().default(0),
    currentVersion: EmployeeVersionSnapshotSchema,
    versions: z.array(EmployeeVersionSnapshotSchema),
  })
  .strict();

export const EmployeeAdminMemberSchema = z
  .object({
    userId: UuidSchema,
    email: z.string().email(),
    displayName: z.string().min(1).max(120),
    role: z.enum(['admin', 'member', 'viewer']),
  })
  .strict();

export const EmployeeAdminDirectoryEntrySchema = z
  .object({
    employeeId: UuidSchema,
    employeeKey: z.string().min(1).max(160),
    status: z.enum(['active', 'archived']),
    currentVersion: EmployeeVersionSnapshotSchema,
    assignedUserIds: z.array(UuidSchema),
  })
  .strict();

export const CreateEmployeeInputSchema = z
  .object({
    workspaceId: UuidSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    partnerProfile: PartnerProfileSchema,
    appearance: EmployeeAppearanceSchema.optional(),
    applicableScenarios: z
      .array(z.string().trim().min(1).max(300))
      .max(24)
      .default([]),
    behaviorRules: z
      .array(z.string().trim().min(1).max(500))
      .max(32)
      .default([]),
    safetyBoundaries: z
      .array(z.string().trim().min(1).max(500))
      .max(32)
      .default([]),
    skillVersionIds: z.array(UuidSchema).max(32).default([]),
  })
  .strict();

export const PublishEmployeeVersionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    skillVersionIds: z.array(UuidSchema).max(32).optional(),
    partnerProfile: PartnerProfileSchema.optional(),
    appearance: EmployeeAppearanceSchema.optional(),
    applicableScenarios: z
      .array(z.string().trim().min(1).max(300))
      .max(24)
      .optional(),
    behaviorRules: z
      .array(z.string().trim().min(1).max(500))
      .max(32)
      .optional(),
    safetyBoundaries: z
      .array(z.string().trim().min(1).max(500))
      .max(32)
      .optional(),
    identity: EmployeeIdentitySchema.optional(),
    runtimePolicy: EmployeeRuntimePolicySchema.optional(),
    securityPolicy: EmployeeSecurityPolicySchema.optional(),
    userProfilePolicy: EmployeeUserProfilePolicySchema.optional(),
    toolNames: z.array(z.string().trim().min(1).max(160)).max(64).optional(),
  })
  .strict();

export const ManageEmployeeAssignmentsInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    userIds: z.array(UuidSchema).max(500),
  })
  .strict();

export const UpdateEmployeeStatusInputSchema = z
  .object({
    workspaceId: UuidSchema,
    status: z.enum(['active', 'archived']),
  })
  .strict();

export const EmployeeUserProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    displayName: z.string().trim().min(1).max(120).nullable(),
    preferences: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EmployeeUserProfile = z.infer<typeof EmployeeUserProfileSchema>;

export const FrozenEmployeeSkillBindingSchema = z
  .object({
    installationId: UuidSchema,
    skillVersionId: UuidSchema,
    declaredCapabilities: z.array(SkillCapabilitySchema).max(16).default([]),
    grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
  })
  .strict();

export const EmployeeExecutionSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    employee: z
      .object({
        id: UuidSchema,
        key: z.string().min(1).max(160),
        versionId: UuidSchema,
        revision: z.number().int().positive(),
        definitionChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        definition: EmployeeManifestSchema,
      })
      .strict(),
    assignment: z
      .object({
        id: UuidSchema,
        userId: UuidSchema,
        assignedBy: UuidSchema.nullable(),
        assignedAt: TimestampSchema,
      })
      .strict(),
    runtimePolicy: EmployeeRuntimePolicySchema,
    capabilitySnapshot: z
      .object({
        declaredCapabilities: z.array(SkillCapabilitySchema).max(16),
        grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
        bindings: EmployeeCapabilityBindingsSchema,
        skillBindings: z.array(FrozenEmployeeSkillBindingSchema).max(32),
      })
      .strict(),
    tenantContext: z
      .object({
        organizationId: UuidSchema,
        workspaceId: UuidSchema,
        actorId: UuidSchema,
        policySnapshotId: UuidSchema,
      })
      .strict(),
    userProfile: EmployeeUserProfileSchema,
    createdAt: TimestampSchema,
  })
  .strict();

export const EmployeeExecutionSnapshotV2Schema =
  EmployeeExecutionSnapshotV1Schema.extend({
    schemaVersion: z.literal(2),
    modelSnapshot: SessionModelSnapshotSchema.optional(),
    capabilitySnapshot: z
      .object({
        declaredCapabilities: z.array(SkillCapabilitySchema).max(16),
        grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
        bindings: EmployeeCapabilityBindingsSchema,
        skillBindings: z.array(FrozenEmployeeSkillBindingSchema).max(32),
        agentSkills: z.array(FrozenAgentSkillBindingSchema).max(32),
        workflows: z.array(FrozenWorkflowBindingSchema).max(32),
        knowledge: z.array(FrozenKnowledgeBindingSchema).max(32),
        resolvedForActorId: UuidSchema,
      })
      .strict(),
  }).strict();

export const EmployeeExecutionSnapshotSchema = z.discriminatedUnion(
  'schemaVersion',
  [EmployeeExecutionSnapshotV1Schema, EmployeeExecutionSnapshotV2Schema],
);
export type EmployeeExecutionSnapshot = z.infer<
  typeof EmployeeExecutionSnapshotSchema
>;

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
            id: UuidSchema.optional(),
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
    imageAttachments: z.array(PromptImageAttachmentSchema).max(20).default([]),
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
    providerSnapshot: HarnessExecutionSnapshotSchema,
    skillVersionIds: z.array(UuidSchema),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .strict();
