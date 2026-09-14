import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import { PROVIDER, requireCheck } from './p27-assistant-preflight.ts';

/** Checks the public adapter handoff, not only its underlying PG ledger. */
export function validateP27AssistantOutcome(
  result: HarnessExecutionResult,
  budgets: readonly { metric: string; spent: number }[],
) {
  requireCheck(
    result.assistantStatus === 'completed',
    'adapter_assistant_status',
  );
  requireCheck(result.usageComplete === true, 'adapter_usage_incomplete');
  // Current production whole-tree summary does not retain cache breakdown or
  // bind an authoritative price. Zero is only its marked-unknown placeholder.
  requireCheck(
    result.cacheUsageKnown === false && result.costEstimateAvailable === false,
    'adapter_unknown_accounting_flags',
  );
  const input = budgets.find((budget) => budget.metric === 'input_tokens');
  const output = budgets.find((budget) => budget.metric === 'output_tokens');
  requireCheck(
    input &&
      output &&
      result.usage.inputTokens === input.spent &&
      result.usage.outputTokens === output.spent &&
      result.usage.cachedInputTokens === 0,
    'adapter_whole_tree_usage',
  );
  requireCheck(
    result.provider === PROVIDER.route && result.model === PROVIDER.model,
    'adapter_provider_route',
  );
  return {
    assistantStatus: result.assistantStatus,
    usageComplete: result.usageComplete,
    cacheUsageKnown: result.cacheUsageKnown,
    costEstimateAvailable: result.costEstimateAvailable,
    usage: { ...result.usage },
    provider: result.provider,
    model: result.model,
  };
}
