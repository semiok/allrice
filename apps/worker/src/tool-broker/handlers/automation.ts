import { createOnceTaskFromExecutionContext } from '@allrice/database';

import { HandlerError } from '../../errors.js';
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
  });
  return {
    modelContent: JSON.stringify({
      automationId: automation.id,
      name: automation.name,
      runAt: automation.runAt,
      sessionId: automation.sessionId,
      status: automation.status,
    }),
    summary: `已创建一次性任务，计划于 ${automation.runAt} 执行`,
    itemCount: 1,
  };
};
