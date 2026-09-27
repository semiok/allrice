import type { ModelRunLimits } from '@allrice/contracts';
import type { HarnessExecutionResult } from './harness/adapter.js';
import { HandlerError } from './errors.js';

type BudgetScope = {
  /** Derived from the server-verified frozen route, never from request input. */
  verifiedSubscription: boolean;
  governedAssistants?: boolean;
  workflow?: boolean;
};

/** First-call telemetry estimate; never a whole-task usage allowance. */
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
  return input.estimatedInputTokens + input.limits.maxOutputTokens;
}

export function assertInitialModelInputBudget(
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
}

/** Final answer validity only. Token/cost usage is retained as telemetry. */
export function checkCompletedModelBudget(
  input: BudgetScope & {
    limits: ModelRunLimits | null | undefined;
    result: HarnessExecutionResult;
    costCents: number | null;
  },
) {
  const { result } = input;
  // Accounting completeness is independent of deliverable completeness.
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
