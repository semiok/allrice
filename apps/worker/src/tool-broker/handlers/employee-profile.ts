import {
  updateEmployeeProfileFromChat,
  EmployeeProfileChatError,
  EmployeeInstanceError,
  EmployeeAccessBusyError,
  DataAccessError,
  ArtifactReviewError,
} from '@allrice/database';
import { ZodError } from 'zod';
import { confirmToolFailure, HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';

export const updateEmployeeProfile: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
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
      'EMPLOYEE_PROFILE_UNAVAILABLE',
      '当前任务不能修改个人设置。',
    );
  try {
    const result = await updateEmployeeProfileFromChat({
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
    const styles = {
      concise: '简洁',
      structured: '结构化',
      exploratory: '探索式',
    };
    const changes = [
      ...(args.name === undefined ? [] : [`个人名称：${result.profile.name}`]),
      ...(args.expressionStyle === undefined || !result.profile.expressionStyle
        ? []
        : [`默认表达方式：${styles[result.profile.expressionStyle]}`]),
    ];
    const receipt = `已保存${changes.join('；')}。下个任务起生效，你可以再说一句改回去。`;
    return {
      modelContent: JSON.stringify({
        instanceId: result.id,
        revision: result.revision,
        profile: result.profile,
        effectiveFrom: 'next_task',
        receipt,
      }),
      summary: receipt,
    };
  } catch (error) {
    if (error instanceof EmployeeInstanceError)
      throw rejected(
        'EMPLOYEE_PROFILE_CONFLICT',
        '个人设置已变化或已归档。本次没有覆盖，请在新任务中重新确认调整。',
      );
    if (error instanceof EmployeeProfileChatError)
      throw rejected(
        'EMPLOYEE_PROFILE_DENIED',
        error.code === 'general_profile_style_only'
          ? '通用 AllRice 助手只允许调整你自己的默认表达方式，不能修改名称或人设；本次未保存。'
          : '当前任务或授权已失效，未修改个人设置。',
      );
    if (error instanceof EmployeeAccessBusyError)
      throw rejected(
        'EMPLOYEE_PROFILE_BUSY',
        '个人设置暂时繁忙，请稍后重试原调整请求。当前权限仍会重新核对。',
      );
    // These errors arise before commit or after a confirmed transaction
    // rollback. Connection/commit uncertainty must keep the ordinary unknown
    // accounting path, never be declared a safely failed write.
    if (
      error instanceof DataAccessError ||
      error instanceof ArtifactReviewError ||
      error instanceof ZodError
    )
      throw rejected(
        'EMPLOYEE_PROFILE_DENIED',
        '参数、授权或当前任务不可用，本次未保存个人设置。',
      );
    throw error;
  }
};
