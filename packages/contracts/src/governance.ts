import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

/** Safe public copy; never return raw provider errors or claim unknown == exhausted. */
export function modelGovernanceFailureText(
  code: string | null | undefined,
): string | null {
  switch (code) {
    case 'MODEL_OUTPUT_BUDGET_EXCEEDED':
      return '本次任务达到平台内部输出 Token 预算，不代表 Codex 订阅周额度已用完。';
    case 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED':
      return '本次任务达到平台内部累计 Token 预算（包含缓存读取），不代表 Codex 订阅周额度已用完。';
    case 'MODEL_COST_BUDGET_EXCEEDED':
      return '本次任务达到平台设置的 API 费用预算上限。';
    case 'MODEL_TOKEN_USAGE_UNKNOWN':
      return '历史任务有尚未核对的模型用量，当前请求未调用模型。请联系平台管理员核对，或审批异常用量预算后继续；反复重试不会解除此限制。';
    case 'MODEL_COST_USAGE_UNKNOWN':
      return '历史任务的 API 费用尚未核对，当前请求未调用模型。请联系平台管理员处理；这不代表订阅额度已用完。';
    case 'MODEL_RUN_QUOTA_EXCEEDED':
    case 'MODEL_REQUEST_QUOTA_EXCEEDED':
      return '已达到平台设置的运行次数上限，请联系平台管理员检查内部配额。';
    case 'MODEL_TOKEN_QUOTA_EXCEEDED':
      return '本次请求达到平台内部 Token 预算限制（含已批准的异常预算预留）。这不是 Codex 周额度提示，请联系平台管理员检查。';
    case 'MODEL_COST_QUOTA_EXCEEDED':
      return '已达到平台设置的 API 费用预算上限，请联系平台管理员检查。';
    default:
      return null;
  }
}

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
    // API/legacy monetary subtotal. An empty subtotal is not a subscription price.
    usedCostCents: z.number().nonnegative().nullable(),
    unknownCostRuns: z.number().int().nonnegative().default(0),
    // NULL monetary values with new, durable subscription proofs, not API unknown.
    subscriptionRuns: z.number().int().nonnegative().default(0),
    usageComplete: z.boolean().default(true),
    // Administrative organization-budget holds are never actual Token usage.
    reservedTokenBudget: z.number().int().nonnegative().default(0),
    unknownUsageRuns: z.number().int().nonnegative().default(0),
    subscriptionBudgetAdmissionComplete: z.boolean().default(false),
    cacheUsageKnown: z.boolean().default(true),
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

export const ReviewSubscriptionUsageBudgetInputSchema = z
  .object({
    decisionId: UuidSchema,
    reservedTokens: z.number().int().positive().max(10_000_000_000),
    reason: z.string().trim().min(10).max(2000),
    acceptUnknownUsage: z.literal(true),
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
    maxRuntimeMs: z.number().int().min(0).max(86400000),
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
