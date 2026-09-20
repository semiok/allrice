import type { ModelRunLimits } from '@allrice/contracts';
import type { HarnessExecutionResult } from './harness/adapter.js';
import { HandlerError } from './errors.js';

type BudgetScope = {
  /** Derived from the server-verified frozen route, never from request input. */
  verifiedSubscription: boolean;
  governedAssistants: boolean;
  workflow?: boolean;
};

function observeCumulativeUsage(scope: BudgetScope) {
  return (
    scope.verifiedSubscription && !scope.governedAssistants && !scope.workflow
  );
}

/** A first-call estimate for monthly admission, NOT a whole-task reservation or
 * ceiling. Ordinary subscription tasks settle their actual cumulative receipts.
 * Existing frozen maxTotalTokens stays intact for API/workflow/root budgets. */
export function modelAdmissionTokenEstimate(
  input: BudgetScope & {
    limits: ModelRunLimits;
    estimatedInputTokens: number;
  },
) {
  if (
    !Number.isSafeInteger(input.estimatedInputTokens) ||
    input.estimatedInputTokens < 0
  )
    throw new HandlerError(
      'MODEL_INPUT_BUDGET_EXCEEDED',
      'Invalid input token estimate',
      false,
    );
  return observeCumulativeUsage(input)
    ? input.estimatedInputTokens + input.limits.maxOutputTokens
    : input.limits.maxTotalTokens;
}

export function assertInitialModelInputBudget(
  input: BudgetScope & {
    limits: ModelRunLimits;
    estimatedInputTokens: number;
  },
) {
  if (
    !Number.isSafeInteger(input.estimatedInputTokens) ||
    input.estimatedInputTokens < 0 ||
    input.estimatedInputTokens > input.limits.maxInputTokens ||
    (!observeCumulativeUsage(input) &&
      input.estimatedInputTokens > input.limits.maxTotalTokens)
  )
    throw new HandlerError(
      'MODEL_INPUT_BUDGET_EXCEEDED',
      'Frozen employee model input budget was exceeded',
      false,
    );
}

/** Post-flight accounting, not a substitute for admission/runtime limits. */
export function checkCompletedModelBudget(
  input: BudgetScope & {
    limits: ModelRunLimits | null | undefined;
    result: HarnessExecutionResult;
    costCents: number | null;
  },
) {
  const { limits, result } = input;
  if (observeCumulativeUsage(input)) {
    // Initial input checks and adapter output settings remain at dispatch. Re-reading context
    // and generating output over multiple calls are observations, not violations
    // of the old single-task 136k/16k cumulative thresholds. Keep receipts intact.
    if (result.usageComplete !== true)
      throw new HandlerError(
        'MODEL_TOKEN_USAGE_UNKNOWN',
        'Model usage receipt is incomplete',
        false,
      );
    if (result.assistantStatus === 'partial')
      throw new HandlerError(
        'ASSISTANT_PARTIAL_RESULT',
        'Only a partial answer was produced',
        false,
      );
    if (!result.answer.trim())
      throw new HandlerError(
        'EMPTY_RESPONSE',
        'Model returned no final answer',
        false,
      );
    return undefined;
  }
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
  // Retain legacy workflow completion behavior outside ordinary subscription tasks.
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
