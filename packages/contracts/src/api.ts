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
  'PROVIDER_INVALID',
  'SKILL_NOT_INSTALLED',
  'NOT_FOUND',
  'QUOTA_EXCEEDED',
  'SIGNED_ACCESS_DENIED',
  'INTERNAL_ERROR',
]);

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1),
        requestId: UuidSchema,
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const CompatibilityPolicy = Object.freeze({
  apiVersion: 'v1',
  contractVersion: ContractVersion,
  minimumReadableContractVersion: 1,
  eventReplayWindowSeconds: 86_400,
  rollingUpgradeContractVersions: [1] as const,
});
