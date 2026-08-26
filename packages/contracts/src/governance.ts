import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const ProviderCircuitStateSchema = z.enum([
  'closed',
  'open',
  'half_open',
]);

export const ProviderGovernanceSchema = z
  .object({
    connectionId: UuidSchema,
    killSwitch: z.boolean(),
    circuitState: ProviderCircuitStateSchema,
    consecutiveFailures: z.number().int().nonnegative(),
    openedUntil: TimestampSchema.nullable(),
    lastErrorCode: z.string().trim().min(1).max(160).nullable(),
    updatedAt: TimestampSchema.nullable(),
    releaseStage: z
      .enum(['experimental', 'canary', 'production', 'disabled'])
      .default('experimental'),
    productionApproved: z.boolean().default(false),
    allowlistedOrganizationIds: z.array(UuidSchema).default([]),
  })
  .strict();

export const OrganizationModelQuotaSchema = z
  .object({
    organizationId: UuidSchema,
    monthlyRunLimit: z.number().int().positive().max(100_000_000),
    monthlyTokenLimit: z.number().int().positive().max(10_000_000_000),
    monthlyCostLimitCents: z.number().int().nonnegative().max(1_000_000_000),
    usedRuns: z.number().int().nonnegative(),
    usedTokens: z.number().int().nonnegative(),
    usedCostCents: z.number().nonnegative(),
    periodStart: TimestampSchema,
  })
  .strict();

export const UpdateProviderGovernanceInputSchema = z
  .object({
    killSwitch: z.boolean().optional(),
    resetCircuit: z.boolean().optional(),
    releaseStage: z
      .enum(['experimental', 'canary', 'production', 'disabled'])
      .optional(),
    productionApproved: z.boolean().optional(),
    allowlistedOrganizationIds: z.array(UuidSchema).max(10_000).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.killSwitch !== undefined ||
      input.resetCircuit === true ||
      input.releaseStage !== undefined ||
      input.productionApproved !== undefined ||
      input.allowlistedOrganizationIds !== undefined,
    'a governance update is required',
  );

export const UpdateOrganizationModelQuotaInputSchema = z
  .object({
    monthlyRunLimit: z.number().int().positive().max(100_000_000),
    monthlyTokenLimit: z.number().int().positive().max(10_000_000_000),
    monthlyCostLimitCents: z.number().int().nonnegative().max(1_000_000_000),
  })
  .strict();

export const ProviderFailureCategorySchema = z.enum([
  'provider_unavailable',
  'rate_limited',
  'timeout',
  'transient_error',
]);

export const ModelResourceScopeSchema = z.enum([
  'tenant',
  'user',
  'employee',
  'provider',
]);

export const ModelResourceStatusSchema = z
  .object({
    scope: ModelResourceScopeSchema,
    scopeId: UuidSchema,
    monthlyRunLimit: z.number().int().positive(),
    monthlyTokenLimit: z.number().int().positive(),
    concurrentRunLimit: z.number().int().positive(),
    maxRuntimeMs: z.number().int().positive(),
    usedRuns: z.number().int().nonnegative(),
    usedTokens: z.number().int().nonnegative(),
    activeRuns: z.number().int().nonnegative(),
  })
  .strict();

export const ProviderReleaseControlSchema = z
  .object({
    connectionId: UuidSchema,
    releaseStage: z.enum(['experimental', 'canary', 'production', 'disabled']),
    allowlistedOrganizationIds: z.array(UuidSchema),
    productionApproved: z.boolean(),
  })
  .strict();
