import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import {
  selectedProvider,
  requireCheck,
  type P27ProviderRoute,
} from './p27-assistant-preflight.ts';
import type { P27PricingSummary } from './p27-assistant-pricing.ts';

/** Checks the public adapter handoff, not only its underlying PG ledger. */
export function validateP27AssistantOutcome(
  result: HarnessExecutionResult,
  budgets: readonly { metric: string; spent: number }[],
  providerRoute: P27ProviderRoute = 'openai-codex',
  pricing?: P27PricingSummary,
) {
  const provider = selectedProvider(providerRoute);
  requireCheck(
    result.provider === provider.route && result.model === provider.model,
    'adapter_provider_route',
  );
  requireCheck(
    result.assistantStatus === 'completed',
    'adapter_assistant_status',
  );
  requireCheck(result.usageComplete === true, 'adapter_usage_incomplete');
  if (providerRoute === 'gemini') {
    requireCheck(
      pricing?.usageComplete &&
        pricing.costCentsDecimal !== null &&
        pricing.costBasis === 'conservative_upper_bound' &&
        pricing.currency === 'USD' &&
        !pricing.cacheUsageKnown &&
        !pricing.actualCostKnown &&
        result.costEstimateAvailable === true &&
        result.estimatedCostCents === Number(pricing.costCentsDecimal) &&
        result.priceSnapshotDigest === pricing.snapshotDigest &&
        result.costCurrency === pricing.currency &&
        result.costBasis === 'conservative_upper_bound' &&
        result.actualCostKnown === false &&
        result.cacheUsageKnown === false,
      'adapter_priced_accounting',
    );
  } else {
    // Historical unsupported Codex fixture assertions are retained as unpriced,
    // never confused with the explicitly priced Gemini execution path.
    requireCheck(
      !pricing &&
        result.cacheUsageKnown === false &&
        result.costEstimateAvailable === false,
      'adapter_unknown_accounting_flags',
    );
  }
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
  return {
    assistantStatus: result.assistantStatus,
    usageComplete: result.usageComplete,
    cacheUsageKnown: result.cacheUsageKnown,
    costEstimateAvailable: result.costEstimateAvailable,
    usage: { ...result.usage },
    provider: result.provider,
    model: result.model,
    ...(pricing
      ? {
          estimatedCostCents: result.estimatedCostCents,
          costCurrency: result.costCurrency,
          costBasis: result.costBasis,
          actualCostKnown: result.actualCostKnown,
          priceSnapshotDigest: result.priceSnapshotDigest,
        }
      : {}),
  };
}
