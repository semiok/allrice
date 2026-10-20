import {
  createOnceTaskFromExecutionContext,
  createRecurringTaskFromExecutionContext,
  NativeOnceProductError,
  NativeRecurringProductError,
} from '@allrice/database';
import { RecurringScheduleRuleSchema } from '@allrice/contracts';
import { z } from 'zod';

import { HandlerError, confirmToolFailure } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';

const content = {
  name: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(40_000),
};
const CreateScheduleArguments = z.union([
  z
    .object({ ...content, delayMinutes: z.number().int().min(1).max(525_600) })
    .strict(),
  z.object({ ...content, rule: RecurringScheduleRuleSchema }).strict(),
]);

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
      '当前任务不能创建定时任务。',
      false,
    );
  const parsed = CreateScheduleArguments.safeParse(args);
  if (!parsed.success) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '定时参数需提供 name、prompt，以及 delayMinutes 或 rule 之一。一次性延迟为 1–525600 分钟；周期仅支持每隔至少 60 秒，或每日明确时间和 IANA 时区。',
      false,
    );
  }
  const common = {
    context: input.context,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    callId: input.call.id,
    arguments: args,
    worker: {
      attempt: input.managedBrowserJobAttempt!,
      leaseToken: input.managedBrowserJobLeaseToken,
    },
    name: parsed.data.name,
    prompt: parsed.data.prompt,
  };
  const reject = (error: unknown): never => {
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
    if (error instanceof NativeRecurringProductError) {
      if (error.code === 'intent_required')
        rejected(
          'AUTOMATION_REQUEST_UNCLEAR',
          '未创建任务。当前用户消息需明确说明每隔整数分钟、小时或天数，或每日 HH:mm[:ss] 与 IANA 时区，并包含具体工作。引用、条件、否定、历史认可、多种周期及周/月规则不能作为本次授权，请先澄清。',
        );
      if (error.code === 'rule_mismatch')
        rejected(
          'AUTOMATION_RULE_MISMATCH',
          '未创建任务。周期、时间或时区与当前用户原话不一致，请按明确原话传参，不要自行猜测或修改。',
        );
    }
    throw error;
  };
  if ('rule' in parsed.data) {
    const task = await createRecurringTaskFromExecutionContext({
      ...common,
      rule: parsed.data.rule,
    }).catch(reject);
    return {
      modelContent: JSON.stringify({
        automationId: task.id,
        clientRequestId: task.clientRequestId,
        name: task.name,
        rule: task.rule,
        nextRunAt: task.nextRunAt,
        sessionId: task.sessionId,
        status: task.status,
        prompt: task.prompt,
      }),
      summary:
        task.status === 'preparing'
          ? '已保存周期任务，等待调度确认；可在当前对话的定时任务中查看。'
          : task.nextRunAt
            ? `已保存周期任务，下一次计划于 ${task.nextRunAt} 执行`
            : '已保存周期任务，可在当前对话的定时任务中查看状态。',
      itemCount: 1,
    };
  }
  const automation = await createOnceTaskFromExecutionContext({
    ...common,
    delayMinutes: parsed.data.delayMinutes,
  }).catch(reject);
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
