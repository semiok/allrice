import {
  executeProjectWorkspace,
  ProjectWorkspaceError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError } from '../../errors.js';
import type { RiceToolHandler } from '../types.js';

export const runProjectWorkspace: RiceToolHandler = async ({
  input,
  arguments: args,
}) => {
  if (
    !input.sessionId ||
    input.managedBrowserJobAttempt === undefined ||
    !input.managedBrowserJobLeaseToken
  )
    throw new HandlerError(
      'PROJECT_TASK_UNAVAILABLE',
      '项目操作需要当前任务的有效执行上下文。',
      false,
    );
  try {
    const result = await executeProjectWorkspace(
      {
        context: input.context,
        sessionId: input.sessionId,
        callId: input.call.id,
        worker: {
          attempt: input.managedBrowserJobAttempt,
          leaseToken: input.managedBrowserJobLeaseToken,
        },
        arguments: args,
      },
      new LocalStorageAdapter(input.storageRoot),
    );
    return {
      modelContent: JSON.stringify(result),
      summary:
        args.action === 'open' || args.action === 'apply'
          ? '项目源码已保存；尚未执行构建'
          : '已读取指定版本的项目源码',
    };
  } catch (error) {
    if (error instanceof ProjectWorkspaceError)
      throw new HandlerError(
        `PROJECT_${error.code.toUpperCase()}`,
        error.message,
        false,
      );
    throw error;
  }
};
