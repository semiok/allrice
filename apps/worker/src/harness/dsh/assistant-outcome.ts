import { HandlerError } from '../../errors.js';
import type { HarnessExecutionResult } from '../adapter.js';
import {
  attachAssistantFailureDiagnostics,
  getAssistantFailureDiagnostics,
} from './assistant-diagnostics.js';

export interface AssistantFailureUsage {
  usage: HarnessExecutionResult['usage'];
  usageComplete: boolean;
  cacheUsageKnown: boolean;
}
// Local trusted bookkeeping, not serializable authority. Preserve the original
// error identity/code/retry semantics, including frozen errors. Bind receipts
// to this Run/attempt so an old or foreign exception cannot settle another one.
const failureUsage = new WeakMap<
  object,
  AssistantFailureUsage & {
    runId: string;
    attempt: number;
  }
>();
export function attachAssistantFailureUsage(
  error: unknown,
  runId: string,
  attempt: number,
  receipt: AssistantFailureUsage,
) {
  if (typeof error !== 'object' || error === null) return;
  failureUsage.set(error, {
    ...receipt,
    usage: { ...receipt.usage },
    runId,
    attempt,
  });
}
export function getAssistantFailureUsage(
  error: unknown,
  runId: string,
  attempt: number,
) {
  if (typeof error !== 'object' || error === null) return undefined;
  const receipt = failureUsage.get(error);
  if (receipt?.runId !== runId || receipt.attempt !== attempt) return undefined;
  return {
    usage: { ...receipt.usage },
    usageComplete: receipt.usageComplete,
    cacheUsageKnown: receipt.cacheUsageKnown,
  };
}
/** Carries only confirmed whole-tree usage into failure accounting. Unknown
 * usage remains reserved; no plain successful answer or estimated zero price. */
export class AssistantExecutionUnresolvedError extends HandlerError {
  constructor(
    readonly usage: HarnessExecutionResult['usage'],
    readonly usageComplete = false,
    diagnostics?: unknown,
  ) {
    super(
      'ASSISTANT_EXECUTION_UNRESOLVED',
      '助手执行结果尚未确认；已保存可用成果，待恢复执行状态。',
      false,
    );
    attachAssistantFailureDiagnostics(this, diagnostics);
  }
}

/** Run has no 'partial success' state. Save the clearly marked partial answer,
 * then fail non-retryably instead of declaring the entire job successful. */
export function assertAssistantTaskComplete(
  result: HarnessExecutionResult,
  verifiedSubscription = false,
) {
  void verifiedSubscription; // Compatibility with older callers; policy applies to every route.
  if (!result.assistantStatus) return;
  const diagnostics = getAssistantFailureDiagnostics(result);
  if (result.assistantStatus === 'partial') {
    const error = new HandlerError(
      'ASSISTANT_PARTIAL_RESULT',
      '已保存部分结果；助手仍有未完成事项，整项任务未确认成功。',
      false,
    );
    attachAssistantFailureDiagnostics(error, diagnostics);
    throw error;
  }
}
