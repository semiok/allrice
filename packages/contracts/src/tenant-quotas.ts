import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const TenantQuotaScopeSchema = z.enum([
  'organization',
  'tenant',
  'user',
]);
export const TenantQuotaLimitsSchema = z
  .object({
    monthlyRunLimit: z.number().int().min(1).max(2147483647),
    monthlyTokenLimit: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    concurrentRunLimit: z.number().int().min(1).max(10000),
    maxRuntimeMs: z.union([
      z.literal(0),
      z.number().int().min(1000).max(86400000),
    ]),
  })
  .strict();
export const TenantQuotaChangeSchema = z
  .object({
    workspaceId: UuidSchema,
    subjectId: UuidSchema,
    scope: TenantQuotaScopeSchema,
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    limits: TenantQuotaLimitsSchema.nullable(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type TenantQuotaLimits = z.infer<typeof TenantQuotaLimitsSchema>;
export interface AdminTenantQuota {
  scope: z.infer<typeof TenantQuotaScopeSchema>;
  scopeId: string;
  version: string | null;
  source: 'tenant_override' | 'platform_override' | 'platform_default';
  effective: TenantQuotaLimits;
  usedRuns: number;
  usedTokens: number;
  cachedInputTokens: number | null;
  unknownUsageRuns: number;
  reservedTokens: number;
  activeRuns: number | null;
  usageScope: 'organization' | 'workspace';
}
export interface AdminTenantQuotas {
  organizationId: string;
  workspaceId: string;
  subjectId: string;
  periodStart: string;
  resetsAt: string;
  quotas: AdminTenantQuota[];
  subscription: {
    status: 'not_queried';
    message: string;
    tokenPolicy?: 'observe' | 'enforce';
  };
}
