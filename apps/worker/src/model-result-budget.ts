import type { ModelRunLimits } from '@allrice/contracts';
import type { HarnessExecutionResult } from './harness/adapter.js';
import { HandlerError } from './errors.js';

/** Post-flight accounting, not a substitute for admission/runtime limits. */
export function checkCompletedModelBudget(input: {
  limits: ModelRunLimits | null | undefined;
  result: HarnessExecutionResult;
  verifiedSubscription: boolean;
  governedAssistants: boolean;
  costCents: number | null;
}) {
  const { limits, result } = input;
  if (!limits) return undefined;
  const code =
    result.usage.outputTokens > limits.maxOutputTokens
      ? 'MODEL_OUTPUT_BUDGET_EXCEEDED'
      : result.usage.inputTokens + result.usage.outputTokens >
          limits.maxTotalTokens
        ? 'MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED'
        : !input.verifiedSubscription &&
            limits.maxCostCents !== null &&
            (input.costCents === null || input.costCents > limits.maxCostCents)
          ? 'MODEL_COST_BUDGET_EXCEEDED'
          : undefined;
  if (!code) return undefined;
  // A complete, identity-verified ordinary subscription answer is deliverable.
  // Preserve actual usage (INCLUDING cache reads). Never soften unknown usage,
  // API money limits, child/root budget settlement, or a partial result.
  if (
    input.verifiedSubscription &&
    !input.governedAssistants &&
    result.usageComplete === true &&
    result.assistantStatus !== 'partial' &&
    result.answer.trim().length > 0 &&
    code !== 'MODEL_COST_BUDGET_EXCEEDED'
  ) {
    return {
      code,
      inputTokens: result.usage.inputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      outputTokens: result.usage.outputTokens,
      maxTotalTokens: limits.maxTotalTokens,
      maxOutputTokens: limits.maxOutputTokens,
    };
  }
  throw new HandlerError(code, 'Frozen model run budget was exceeded', false);
}
