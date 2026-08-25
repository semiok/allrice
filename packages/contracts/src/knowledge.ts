import { z } from 'zod';

import { TimestampSchema, UuidSchema, VisibilitySchema } from './common.ts';
import { CapabilityDataScopeSchema } from './capabilities.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillCapabilitySchema } from './skills.ts';

export const KnowledgeLocatorSchema = z
  .object({
    sourceRef: z.string().trim().min(1).max(1_024),
    chunk: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict();

export const KnowledgeCitationSchema = z
  .object({
    type: z.literal('knowledge'),
    id: UuidSchema,
    label: z.string().trim().min(1).max(200),
    knowledgeRevisionId: UuidSchema,
    documentId: UuidSchema,
    sourceKind: z.enum(['workspace_files', 'connector', 'managed']),
    scope: CapabilityDataScopeSchema,
    locator: KnowledgeLocatorSchema,
    updatedAt: TimestampSchema,
    score: z.number().min(-1).max(1),
  })
  .strict();
export type KnowledgeCitation = z.infer<typeof KnowledgeCitationSchema>;

export const KnowledgeRetrievalResultSchema = z
  .object({
    content: z.string().min(1).max(20_000),
    citation: KnowledgeCitationSchema,
  })
  .strict();
export type KnowledgeRetrievalResult = z.infer<
  typeof KnowledgeRetrievalResultSchema
>;

export const ConnectorRiskSchema = z.enum([
  'read_only',
  'write',
  'external_send',
  'high_risk_data',
]);
export const ConnectorIdentityModeSchema = z.enum(['user', 'service']);

export const ConnectorDefinitionSchema = z
  .object({
    id: UuidSchema,
    key: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    capabilities: z.array(SkillCapabilitySchema).min(1).max(16),
    inputSchema: z.record(z.string(), z.unknown()),
    risk: ConnectorRiskSchema,
    identityModes: z.array(ConnectorIdentityModeSchema).min(1).max(2),
    resourceScopes: z.array(CapabilityDataScopeSchema).min(1).max(4),
    enabled: z.boolean(),
  })
  .strict();
export type ConnectorDefinition = z.infer<typeof ConnectorDefinitionSchema>;

export const CreateConnectorDefinitionInputSchema =
  ConnectorDefinitionSchema.omit({ id: true, enabled: true })
    .extend({ workspaceId: UuidSchema })
    .strict();

export const ConnectorBindingSchema = z
  .object({
    id: UuidSchema,
    connectorId: UuidSchema,
    identityMode: ConnectorIdentityModeSchema,
    userId: UuidSchema.nullable(),
    credentialReference: z.string().trim().min(1).max(255),
    resourceScope: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.identityMode === 'user' && !binding.userId) {
      context.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'user identity connector bindings require a user ID',
      });
    }
    if (binding.identityMode === 'service' && binding.userId) {
      context.addIssue({
        code: 'custom',
        path: ['userId'],
        message:
          'service identity connector bindings cannot impersonate a user',
      });
    }
  });
export type ConnectorBinding = z.infer<typeof ConnectorBindingSchema>;

export const CreateConnectorBindingInputSchema = z
  .object({
    workspaceId: UuidSchema,
    connectorId: UuidSchema,
    identityMode: ConnectorIdentityModeSchema,
    userId: UuidSchema.nullable(),
    credentialReference: z.string().trim().min(1).max(255),
    resourceScope: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.identityMode === 'user' && !binding.userId) {
      context.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'user identity connector bindings require a user ID',
      });
    }
    if (binding.identityMode === 'service' && binding.userId) {
      context.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'service identity connector bindings cannot impersonate a user',
      });
    }
  });

export const ConnectorCallRequestSchema = z
  .object({
    connectorBindingId: UuidSchema,
    operation: z.string().regex(/^[a-z][a-z0-9_.-]{0,159}$/),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ConnectorCallRequest = z.infer<typeof ConnectorCallRequestSchema>;

export const ConnectorCallDecisionSchema = z
  .object({
    callId: UuidSchema,
    bindingId: UuidSchema,
    inputDigest: ChecksumSchema,
    identityMode: ConnectorIdentityModeSchema,
    risk: ConnectorRiskSchema,
    status: z.enum(['allowed', 'waiting_approval', 'denied']),
    approvalId: UuidSchema.nullable(),
  })
  .strict();
export type ConnectorCallDecision = z.infer<typeof ConnectorCallDecisionSchema>;

export const DecideApprovalInputSchema = z
  .object({
    workspaceId: UuidSchema,
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const KnowledgeIndexDocumentSchema = z
  .object({
    knowledgeRevisionId: UuidSchema,
    sourceRef: z.string().trim().min(1).max(1_024),
    storageObjectId: UuidSchema.nullable(),
    ownerId: UuidSchema,
    visibility: VisibilitySchema,
    title: z.string().trim().min(1).max(255),
    mediaType: z.string().trim().min(1).max(255),
    checksum: ChecksumSchema,
    updatedAt: TimestampSchema,
    chunks: z
      .array(
        z
          .object({
            content: z.string().trim().min(1).max(20_000),
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(2_000),
  })
  .strict();
export type KnowledgeIndexDocument = z.infer<
  typeof KnowledgeIndexDocumentSchema
>;
