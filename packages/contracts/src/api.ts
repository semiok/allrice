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
