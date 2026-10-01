import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { AssistantFailureDiagnosticsSchema } from './assistant-diagnostics.ts';

/** Presentation only: never change retry, authorization, usage or Run status. */
export function nativeExecutionDiagnosticFailureText(
  code: string | null | undefined,
  payload: unknown,
  message: unknown,
): string | null {
  if (code !== 'DSH_UNKNOWN' || message !== 'assistant_model_unknown_no_replay')
    return null;
  const parsed = z
    .object({
      threadId: z.string().regex(/^dsh-[a-zA-Z0-9_.-]{1,196}$/),
      assistantDiagnostics: AssistantFailureDiagnosticsSchema,
    })
    .safeParse(payload);
  if (!parsed.success || parsed.data.assistantDiagnostics.truncated)
    return null;
  const failure = parsed.data.assistantDiagnostics.failures.findLast(
    (item) => item.nativeSessionId === parsed.data.threadId,
  );
  if (
    !failure ||
    !['finish', 'stream'].includes(failure.phase) ||
    failure.stopKind !== 'error'
  )
    return null;
  return nativeExecutionFailureText(`DSH_${failure.code}`);
}

/** Fixed native failure copy; caller may retain a complete reply alongside it. */
export function nativeExecutionFailureText(
  code: string | null | undefined,
): string | null {
  switch (code) {
    case 'DOCUMENT_DELIVERY_INCOMPLETE':
      return '本轮文档尚未交付完成，回复和历史文件已保留。可继续让员工修正导出；历史版本不会冒充新文件。';
    case 'DSH_TRANSPORT':
      return '模型连接中断，本轮未完成。已产生的内容和工具结果已保留，可展开“工作过程”查看；任务没有整轮重跑。';
    case 'DSH_TIMEOUT':
      return '等待模型响应超时，本轮未完成。已产生的内容和工具结果已保留，可展开“工作过程”查看；任务没有整轮重跑。';
    case 'DSH_PI_AI_ERROR':
    case 'DSH_TURN_FAILED':
      return '模型响应失败，本轮未完成。已产生的内容和工具结果已保留，可展开“工作过程”查看；任务没有整轮重跑。';
    case 'DSH_RECOVERY_REQUIRED':
      return '原执行记录尚不能安全恢复，任务没有自动重跑。已有内容和工具结果已保留，请展开“工作过程”核对。';
    default:
      return null;
  }
}

/** Safe public copy; never return raw provider errors or claim unknown == exhausted. */
export function modelGovernanceFailureText(
  code: string | null | undefined,
): string | null {
  const nativeFailure = nativeExecutionFailureText(code);
  if (nativeFailure) return nativeFailure;
  switch (code) {
    case 'DSH_EXECUTION_OUTCOME_UNKNOWN':
      return '执行进程已中断，结果不明的操作没有自动重跑。已产生的内容与执行记录保留，请先核对操作结果。';
    case 'NATIVE_WAIT_RECOVERY_REJECTED':
      return '等待恢复未得到确认，任务没有自动重跑。请查看保留的内容与执行记录。';
    case 'NATIVE_WAIT_AUTHORITY_CHANGED':
    case 'NATIVE_WAIT_CONFIGURATION_CHANGED':
      return '等待期间的授权或配置已变更，未恢复执行。请重新确认后发起任务；已有内容与执行记录保留。';
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
    maxRuntimeMs: z.number().int().nonnegative(),
    runtimeLimitExplicit: z.boolean().optional(),
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
