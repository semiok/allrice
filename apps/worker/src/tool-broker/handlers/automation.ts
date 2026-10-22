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
      '定时参数需提供 name、prompt，以及 delayMinutes 或 rule 之一。一次性延迟为 1–525600 分钟；周期支持每隔至少 60 秒，或每日、每周明确时间和 IANA 时区。',
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
          '未创建任务。尚不能确定一次性任务的时间和内容，或确认回复没有对应的未完成请求。请结合当前对话澄清缺失信息，不要要求用户重复已经明确的指令；引用、否定或条件表达不代表创建授权。',
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
          '未创建任务。需要明确的周期和具体工作，或当前任务提问卡中用户已选定的完整提醒频率。支持每隔整数分钟、小时或天数，或每日、每周 HH:mm[:ss] 与 IANA 时区；每周还需明确执行日。请结合当前对话澄清缺失信息，不要要求用户重发已知工作；引用、条件、否定、无关历史、多种周期及每月规则不代表创建授权。',
        );
      if (error.code === 'rule_mismatch')
        rejected(
          'AUTOMATION_RULE_MISMATCH',
          '未创建任务。周期、执行日、时间或时区与当前用户原话不一致，请按明确原话传参，不要自行猜测或修改。',
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
          ? '已保存周期任务，等待调度确认；可在左侧“自动化任务”中查看。'
          : task.nextRunAt
            ? `已保存周期任务，下一次计划于 ${task.nextRunAt} 执行`
            : '已保存周期任务，可在左侧“自动化任务”中查看状态。',
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
    summary:
      automation.status === 'preparing'
        ? `已保存一次性任务，等待调度确认；计划于 ${automation.runAt} 执行，可在左侧“自动化任务”中查看。`
        : `已保存一次性任务，计划于 ${automation.runAt} 执行，可在左侧“自动化任务”中查看。`,
    itemCount: 1,
  };
};
