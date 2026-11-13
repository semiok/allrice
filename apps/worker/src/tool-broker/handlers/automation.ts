import {
  createOnceTaskFromExecutionContext,
  createRecurringTaskFromExecutionContext,
  NativeRecurringProductError,
} from '@allrice/database';
import {
  RecurringScheduleRuleSchema,
  AutomationConversationModeSchema,
} from '@allrice/contracts';
import { z } from 'zod';

import { HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';

const content = {
  name: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(40_000),
  conversationMode: AutomationConversationModeSchema.optional(),
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
    ...(parsed.data.conversationMode === undefined
      ? {}
      : { conversationMode: parsed.data.conversationMode }),
  };
  if ('rule' in parsed.data) {
    const task = await createRecurringTaskFromExecutionContext({
      ...common,
      rule: parsed.data.rule,
    }).catch((error: unknown) => {
      if (
        error instanceof NativeRecurringProductError &&
        (error.code === 'confirmation_required' || error.code === 'declined')
      )
        return error;
      throw error;
    });
    // Neither outcome is a failure: the human decides on a card, or did.
    if (task instanceof NativeRecurringProductError)
      return task.code === 'declined'
        ? {
            modelContent: JSON.stringify({
              created: false,
              status: 'declined',
              next: '用户在确认卡上选择了先不创建。本轮不要再创建或再询问，告诉用户没有创建即可。',
            }),
            summary: '你选择了先不创建，没有创建定时任务。',
            itemCount: 0,
          }
        : {
            modelContent: JSON.stringify({
              created: false,
              status: 'confirmation_required',
              askUserQuestion: task.confirmation?.askUserQuestion,
              ...(task.confirmation?.recognized
                ? {
                    recognizedFromUserWords: task.confirmation.recognized,
                    hint: '用户原话可直接识别为上面的频率，与本次参数不同。若是参数写错，按原话改参数重新调用即可，不必让用户确认。',
                  }
                : {}),
              next: '尚未创建。把 askUserQuestion 原样交给 ask_user_question，不要改写任何文字。用户选择“确认：…”后，用完全相同的参数再调用一次 automation.create。',
            }),
            summary: '等你确认后再创建这个定时任务。',
            itemCount: 0,
          };
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
        conversationMode: task.conversationMode,
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
  });
  return {
    modelContent: JSON.stringify({
      automationId: automation.id,
      name: automation.name,
      runAt: automation.runAt,
      sessionId: automation.sessionId,
      status: automation.status,
      prompt: automation.prompt,
      conversationMode: automation.conversationMode,
    }),
    summary: `${automation.status === 'preparing' ? '已保存一次性任务，等待调度确认。' : '已保存一次性任务。'}执行时间：${automation.runAt}（${automation.timezone}）。\n任务内容：\n${automation.prompt}`,
    itemCount: 1,
  };
};
