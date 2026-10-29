import type { HarnessExecutionResult } from '../adapter.js';

export interface ExecutionFailureUsage {
  usage: HarnessExecutionResult['usage'];
  usageComplete: boolean;
  cacheUsageKnown: boolean;
}
// Local trusted bookkeeping, not serializable authority. Preserve the original
// error identity/code/retry semantics, including frozen errors. Bind receipts
// to this Run/attempt so an old or foreign exception cannot settle another one.
const failureUsage = new WeakMap<
  object,
  ExecutionFailureUsage & {
    runId: string;
    attempt: number;
  }
>();
export function attachExecutionFailureUsage(
  error: unknown,
  runId: string,
  attempt: number,
  receipt: ExecutionFailureUsage,
) {
  if (typeof error !== 'object' || error === null) return;
  failureUsage.set(error, {
    ...receipt,
    usage: { ...receipt.usage },
    runId,
    attempt,
  });
}
export function getExecutionFailureUsage(
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
