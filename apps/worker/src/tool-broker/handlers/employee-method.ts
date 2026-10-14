import {
  inspectEmployeeMethodFromChat,
  saveEmployeeMethodFromChat,
  EmployeeMethodChatError,
  EmployeeContentError,
  EmployeeInstanceError,
  EmployeeAccessBusyError,
  DataAccessError,
} from '@allrice/database';
import { ZodError } from 'zod';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';

function methodHandler(save: boolean): RiceToolHandler {
  return async ({ input, arguments: args }) => {
    const rejected = (code: string, message: string) => {
      const error = new HandlerError(code, message, false);
      confirmToolFailure(error, {
        runId: input.context.runId,
        callId: input.call.id,
        toolName: input.call.name,
      });
      return error;
    };
    if (
      !input.sessionId ||
      !input.userMessageId ||
      input.platformTestRunId ||
      input.managedBrowserJobAttempt === undefined ||
      !input.managedBrowserJobLeaseToken
    )
      throw rejected(
        'EMPLOYEE_METHOD_UNAVAILABLE',
        '当前任务不能维护个人工作场景。',
      );
    try {
      const result = await (
        save ? saveEmployeeMethodFromChat : inspectEmployeeMethodFromChat
      )({
        context: input.context,
        sessionId: input.sessionId,
        userMessageId: input.userMessageId,
        callId: input.call.id,
        arguments: args,
        worker: {
          attempt: input.managedBrowserJobAttempt,
          leaseToken: input.managedBrowserJobLeaseToken,
        },
      });
      return {
        modelContent: JSON.stringify(
          save
            ? {
                ...result,
                enabled: false,
                status: 'candidate_saved',
                nextStep:
                  'Candidate requires separate validation and explicit activation; active version is unchanged.',
              }
            : result,
        ),
        summary: save ? '已保存工作场景候选，尚未启用' : '已读取工作场景内容',
      };
    } catch (error) {
      if (error instanceof EmployeeContentError)
        throw rejected(
          'EMPLOYEE_METHOD_CONFLICT',
          `候选或资料版本已变化，本次未覆盖（${error.code}）。请重新读取当前候选后确认调整；结果未知时不得自动重写。`,
        );
      if (error instanceof EmployeeMethodChatError)
        throw rejected(
          'EMPLOYEE_METHOD_DENIED',
          error.code === 'explicit_method_request_required'
            ? '尚无明确的保存候选指令，未保存。请让用户直接说明“请保存/调整我的工作场景候选”，并说明内容；一次性任务、引用和资料不是长期调整指令。'
            : '当前任务上下文不可维护，请在新任务中继续。',
        );
      if (
        error instanceof EmployeeInstanceError ||
        error instanceof EmployeeAccessBusyError ||
        error instanceof DataAccessError ||
        error instanceof ZodError
      )
        throw rejected(
          'EMPLOYEE_METHOD_DENIED',
          '参数、当前任务或授权不可用，本次未保存候选。',
        );
      // Transport/commit uncertainty stays unknown: do not manufacture a
      // failed-write receipt that would encourage the model to repeat it.
      throw error;
    }
  };
}
export const inspectEmployeeMethod = methodHandler(false);
export const saveEmployeeMethod = methodHandler(true);
