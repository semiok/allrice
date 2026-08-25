import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  AgentSkillMetadataSchema,
  SkillCapabilitySchema,
  SkillSourceSchema,
} from './skills.ts';

export const CapabilityRevisionStatusSchema = z.enum([
  'draft',
  'published',
  'deprecated',
  'revoked',
]);

export const CapabilityDataScopeSchema = z.enum([
  'organization',
  'workspace',
  'employee',
  'user',
]);
export type CapabilityDataScope = z.infer<typeof CapabilityDataScopeSchema>;

export const AgentSkillRevisionSchema = z
  .object({
    kind: z.literal('agent_skill'),
    id: UuidSchema,
    agentSkillId: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    publisher: z.string().trim().min(1).max(120),
    revision: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    status: CapabilityRevisionStatusSchema,
    checksum: ChecksumSchema,
    source: SkillSourceSchema,
    metadata: AgentSkillMetadataSchema,
    declaredCapabilities: z.array(SkillCapabilitySchema).max(16),
    publishedAt: TimestampSchema.nullable(),
  })
  .strict();
export type AgentSkillRevision = z.infer<typeof AgentSkillRevisionSchema>;

export const WorkflowStepKindSchema = z.enum([
  'model',
  'agent_skill',
  'knowledge',
  'tool',
  'approval',
]);

export const WorkflowStepDefinitionSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    name: z.string().trim().min(1).max(120),
    kind: WorkflowStepKindSchema,
    dependsOn: z
      .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
      .max(32)
      .default([]),
    input: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
    maxAttempts: z.number().int().min(1).max(10).default(1),
    approval: z.enum(['none', 'required']).default('none'),
  })
  .strict();

export const WorkflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    steps: z.array(WorkflowStepDefinitionSchema).min(1).max(128),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    failurePolicy: z
      .enum(['fail_fast', 'continue_safe_steps', 'manual'])
      .default('fail_fast'),
    recoveryPolicy: z.enum(['checkpoint', 'manual']).default('checkpoint'),
  })
  .strict()
  .superRefine((definition, context) => {
    const keys = new Set<string>();
    for (const [index, step] of definition.steps.entries()) {
      if (keys.has(step.key)) {
        context.addIssue({
          code: 'custom',
          path: ['steps', index, 'key'],
          message: 'workflow step keys must be unique',
        });
      }
      keys.add(step.key);
    }
    for (const [index, step] of definition.steps.entries()) {
      for (const dependency of step.dependsOn) {
        if (!keys.has(dependency) || dependency === step.key) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'dependsOn'],
            message: 'workflow dependencies must reference another step',
          });
        }
      }
    }
    const dependencies = new Map(
      definition.steps.map((step) => [step.key, step.dependsOn]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      for (const dependency of dependencies.get(key) ?? []) {
        if (dependencies.has(dependency) && visit(dependency)) return true;
      }
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    if (definition.steps.some((step) => visit(step.key))) {
      context.addIssue({
        code: 'custom',
        path: ['steps'],
        message: 'workflow dependencies must form an acyclic graph',
      });
    }
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const WorkflowRevisionSchema = z
  .object({
    kind: z.literal('workflow'),
    id: UuidSchema,
    workflowId: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    revision: z.number().int().positive(),
    status: CapabilityRevisionStatusSchema,
    checksum: ChecksumSchema,
    definition: WorkflowDefinitionSchema,
    publishedAt: TimestampSchema.nullable(),
  })
  .strict();
export type WorkflowRevision = z.infer<typeof WorkflowRevisionSchema>;

export const KnowledgeSourceKindSchema = z.enum([
  'workspace_files',
  'connector',
  'managed',
]);

export const KnowledgeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceKind: KnowledgeSourceKindSchema,
    connectorBindingId: UuidSchema.nullable().default(null),
    resourceRef: z.string().trim().min(1).max(1_024),
    indexing: z.enum(['none', 'vector', 'hybrid']).default('hybrid'),
    updatePolicy: z.enum(['manual', 'scheduled', 'event']).default('manual'),
    citationRequired: z.boolean().default(true),
    allowedScopes: z.array(CapabilityDataScopeSchema).min(1).max(4),
  })
  .strict()
  .superRefine((definition, context) => {
    if (
      definition.sourceKind === 'connector' &&
      definition.connectorBindingId === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['connectorBindingId'],
        message: 'connector knowledge requires an opaque connector binding ID',
      });
    }
    if (
      definition.sourceKind !== 'connector' &&
      definition.connectorBindingId !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['connectorBindingId'],
        message: 'only connector knowledge may reference a connector binding',
      });
    }
  });
export type KnowledgeDefinition = z.infer<typeof KnowledgeDefinitionSchema>;

export const KnowledgeAclEntrySchema = z
  .object({
    principalType: CapabilityDataScopeSchema,
    principalId: UuidSchema,
    permission: z.enum(['read', 'admin']),
  })
  .strict();
export type KnowledgeAclEntry = z.infer<typeof KnowledgeAclEntrySchema>;

export const KnowledgeRevisionSchema = z
  .object({
    kind: z.literal('knowledge'),
    id: UuidSchema,
    knowledgeSourceId: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    revision: z.number().int().positive(),
    status: CapabilityRevisionStatusSchema,
    checksum: ChecksumSchema,
    definition: KnowledgeDefinitionSchema,
    acl: z.array(KnowledgeAclEntrySchema).min(1).max(256),
    publishedAt: TimestampSchema.nullable(),
  })
  .strict();
export type KnowledgeRevision = z.infer<typeof KnowledgeRevisionSchema>;

export const CreateWorkflowInputSchema = z
  .object({
    workspaceId: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    definition: WorkflowDefinitionSchema,
  })
  .strict();

export const PublishWorkflowRevisionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(1_000).optional(),
    definition: WorkflowDefinitionSchema,
  })
  .strict();

export const CreateKnowledgeSourceInputSchema = z
  .object({
    workspaceId: UuidSchema,
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    definition: KnowledgeDefinitionSchema,
    acl: z.array(KnowledgeAclEntrySchema).min(1).max(256),
  })
  .strict();

export const PublishKnowledgeRevisionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(1_000).optional(),
    definition: KnowledgeDefinitionSchema,
    acl: z.array(KnowledgeAclEntrySchema).min(1).max(256),
  })
  .strict();

export const UpdateCapabilityStatusInputSchema = z
  .object({
    workspaceId: UuidSchema,
    kind: z.enum(['workflow', 'knowledge']),
    status: z.enum(['active', 'archived']),
  })
  .strict();

export const UpdateCapabilityRevisionStatusInputSchema = z
  .object({
    workspaceId: UuidSchema,
    kind: z.enum(['agent_skill', 'workflow', 'knowledge']),
    status: z.enum(['deprecated', 'revoked']),
  })
  .strict();

export const ManageEmployeeCapabilitiesInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    agentSkills: z
      .array(
        z
          .object({
            installationId: UuidSchema,
            skillVersionId: UuidSchema,
            grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    workflowRevisionIds: z.array(UuidSchema).max(32).default([]),
    knowledgeRevisionIds: z.array(UuidSchema).max(32).default([]),
  })
  .strict();

export const FrozenAgentSkillBindingSchema = z
  .object({
    bindingId: UuidSchema,
    installationId: UuidSchema,
    revision: AgentSkillRevisionSchema,
    grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
    boundBy: UuidSchema,
    boundAt: TimestampSchema,
  })
  .strict();

export const FrozenWorkflowBindingSchema = z
  .object({
    bindingId: UuidSchema,
    revision: WorkflowRevisionSchema,
    boundBy: UuidSchema,
    boundAt: TimestampSchema,
  })
  .strict();

export const FrozenKnowledgeBindingSchema = z
  .object({
    bindingId: UuidSchema,
    revision: KnowledgeRevisionSchema,
    effectiveAcl: z.array(KnowledgeAclEntrySchema).min(1).max(256),
    boundBy: UuidSchema,
    boundAt: TimestampSchema,
  })
  .strict();

export const EmployeeCapabilityDirectorySchema = z
  .object({
    employeeId: UuidSchema,
    agentSkills: z.array(FrozenAgentSkillBindingSchema),
    workflows: z.array(FrozenWorkflowBindingSchema),
    knowledge: z.array(FrozenKnowledgeBindingSchema),
  })
  .strict();
export type EmployeeCapabilityDirectory = z.infer<
  typeof EmployeeCapabilityDirectorySchema
>;

export const CapabilityCatalogSchema = z
  .object({
    agentSkills: z.array(
      z
        .object({
          installationId: UuidSchema,
          grantedCapabilities: z.array(SkillCapabilitySchema).max(16),
          revision: AgentSkillRevisionSchema,
        })
        .strict(),
    ),
    workflows: z.array(WorkflowRevisionSchema),
    knowledge: z.array(KnowledgeRevisionSchema),
  })
  .strict();
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
