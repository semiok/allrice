import { HandlerError } from '../../errors.js';
import type { HarnessExecutionResult } from '../adapter.js';
/** Carries only confirmed whole-tree usage into failure accounting. Unknown
 * usage remains reserved; no plain successful answer or estimated zero price. */
export class AssistantExecutionUnresolvedError extends HandlerError {
  constructor(
    readonly usage: HarnessExecutionResult['usage'],
    readonly usageComplete = false,
  ) {
    super(
      'ASSISTANT_EXECUTION_UNRESOLVED',
      '助手执行或用量尚未核对；已保存可用证据，未确认整项任务成功。',
      false,
    );
  }
}

/** Run has no 'partial success' state. Save the clearly marked partial answer,
 * then fail non-retryably instead of declaring the entire job successful. */
export function assertAssistantTaskComplete(result: HarnessExecutionResult) {
  if (!result.assistantStatus) return;
  if (result.usageComplete !== true)
    throw new AssistantExecutionUnresolvedError(result.usage, false);
  if (result.assistantStatus === 'partial')
    throw new HandlerError(
      'ASSISTANT_PARTIAL_RESULT',
      '已保存部分结果；助手仍有未完成事项，整项任务未确认成功。',
      false,
    );
}
