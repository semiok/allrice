import { createAutomationFromExecutionContext } from '@allrice/database';

import { HandlerError } from '../../errors.js';
import { stringValue } from '../input-values.js';
import type { RiceToolHandler } from '../types.js';

export const createAutomation: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
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
  const automation = await createAutomationFromExecutionContext({
    context: input.context,
    sessionId: input.sessionId,
    name: stringValue(args.name, 'name'),
    prompt: stringValue(args.prompt, 'prompt'),
    delayMinutes,
  });
  return {
    modelContent: JSON.stringify({
      automationId: automation.id,
      name: automation.name,
      runAt: automation.nextRunAt,
      sessionId: automation.lastSessionId,
    }),
    summary: `已创建一次性自动化，将于 ${automation.nextRunAt ?? '指定时间'} 执行`,
    itemCount: 1,
  };
};
