import {
  createOnceTaskFromExecutionContext,
  NativeOnceProductError,
} from '@allrice/database';

import { HandlerError, confirmToolFailure } from '../../errors.js';
import { stringValue } from '../input-values.js';
import type { RiceToolHandler } from '../types.js';

export const createAutomation: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  if (
    !input.sessionId ||
    !input.userMessageId ||
    !input.call.id ||
    input.platformTestRunId ||
    !Number.isSafeInteger(input.managedBrowserJobAttempt) ||
    (input.managedBrowserJobAttempt ?? 0) < 1 ||
    !input.managedBrowserJobLeaseToken
  )
    throw new HandlerError(
      'AUTOMATION_UNAVAILABLE',
      '当前任务不能创建一次性任务。',
      false,
    );
  const delayMinutes = args.delayMinutes;
  if (
    typeof delayMinutes !== 'number' ||
    !Number.isInteger(delayMinutes) ||
    delayMinutes < 1 ||
    delayMinutes > 525600
  ) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      'delayMinutes 必须是 1 到 525600 之间的整数',
      false,
    );
  }
  const automation = await createOnceTaskFromExecutionContext({
    context: input.context,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    callId: input.call.id,
    arguments: args,
    worker: {
      attempt: input.managedBrowserJobAttempt!,
      leaseToken: input.managedBrowserJobLeaseToken,
    },
    name: stringValue(args.name, 'name'),
    prompt: stringValue(args.prompt, 'prompt'),
    delayMinutes,
  }).catch((error: unknown) => {
    const rejected = (code: string, message: string): never => {
      const failure = new HandlerError(code, message, false);
      confirmToolFailure(failure, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      });
      throw failure;
    };
    if (error instanceof NativeOnceProductError) {
      if (error.code === 'intent_required')
        rejected(
          'AUTOMATION_REQUEST_UNCLEAR',
          '未创建任务。当前用户消息需明确要求一次性未来执行，并说明整数分钟、小时或天数及任务内容；引用、询问、条件或周期要求不能作为本次授权。请澄清后再创建。',
        );
      if (error.code === 'time_mismatch')
        rejected(
          'AUTOMATION_TIME_MISMATCH',
          '未创建任务。delayMinutes 与当前用户明确指定的时间不一致，请按用户原话换算，不能自行延长或缩短。',
        );
    }
    throw error;
  });
  return {
    modelContent: JSON.stringify({
      automationId: automation.id,
      name: automation.name,
      runAt: automation.runAt,
      sessionId: automation.sessionId,
      status: automation.status,
      prompt: automation.prompt,
    }),
    summary: `已创建一次性任务，计划于 ${automation.runAt} 执行`,
    itemCount: 1,
  };
};
