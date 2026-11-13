import { z } from 'zod';

import { UuidSchema } from './common.ts';

export const ApiVersionSchema = z.literal('v1');
export const ContractVersion = 1 as const;

export const ApiErrorCodeSchema = z.enum([
  'AUTHENTICATION_REQUIRED',
  'AUTHORIZATION_DENIED',
  'RESOURCE_NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'CURSOR_INVALID',
  'CURSOR_EXPIRED',
  'DEPENDENCY_UNAVAILABLE',
  'APPROVAL_REQUIRED',
  'WORKFLOW_NEEDS_ATTENTION',
  'BRIDGE_REQUEST_INVALID',
  'CAPABILITY_BINDING_INVALID',
  'KNOWLEDGE_ACL_DENIED',
  'VERSION_CONFLICT',
  'DEFAULT_EMPLOYEE_PROTECTED',
  'EMPLOYEE_ASSIGNMENT_INVALID',
  'EMPLOYEE_INSTANCE_ARCHIVED',
  'REFERENCE_PUBLICATION_REVOKED',
  'PROVIDER_INVALID',
  'SKILL_NOT_INSTALLED',
  'NOT_FOUND',
  'QUOTA_EXCEEDED',
  'SIGNED_ACCESS_DENIED',
  'INTERNAL_ERROR',
]);

const memoryDomain = { domain: z.literal('employee_memory') };
export const MemoryConflictDetailsSchema = z.discriminatedUnion('reason', [
  z.object({ ...memoryDomain, reason: z.literal('cas_conflict') }).strict(),
  z
    .object({ ...memoryDomain, reason: z.literal('idempotency_conflict') })
    .strict(),
  z
    .object({
      ...memoryDomain,
      reason: z.literal('memory_limit_reached'),
      counts: z
        .object({ active: z.literal(100), maxActive: z.literal(100) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...memoryDomain,
      reason: z.literal('contract_changed'),
      requiredSchemaVersion: z.literal(2),
    })
    .strict(),
]);
export type MemoryConflictDetails = z.infer<typeof MemoryConflictDetailsSchema>;

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1),
        requestId: UuidSchema,
        retryable: z.boolean(),
        details: MemoryConflictDetailsSchema.optional(),
      })
      .strict()
      .refine(
        (error) =>
          !error.details || (error.code === 'CONFLICT' && !error.retryable),
      ),
  })
  .strict();

export const CompatibilityPolicy = Object.freeze({
  apiVersion: 'v1',
  contractVersion: ContractVersion,
  minimumReadableContractVersion: 1,
  eventReplayWindowSeconds: 86_400,
  rollingUpgradeContractVersions: [1] as const,
});
