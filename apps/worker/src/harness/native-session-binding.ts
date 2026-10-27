import {
  bindJobNativeSession,
  prepareJobNativeSession,
  NativeSessionBindingError,
} from '@allrice/database';
import type { HarnessExecutionInput } from './adapter.js';
import { HandlerError } from '../errors.js';

type BindInput = Parameters<typeof bindJobNativeSession>[0];
/** Only this Worker closure holds the real lease. Never spread it into a
 * kernel, native environment, model-visible schema or diagnostic event. */
export function createJobNativeBinding(input: {
  lease: Pick<BindInput, 'workerId' | 'jobId' | 'leaseToken'>;
  attempt: number;
  subject: () => BindInput['subject'];
  beforeBind?: () => Promise<void>;
  onBound?: (
    value: Awaited<ReturnType<typeof bindJobNativeSession>>,
    descriptor: BindInput['descriptor'],
  ) => Promise<void>;
}): NonNullable<HarnessExecutionInput['nativeBinding']> {
  const lease = () => ({
    workerId: input.lease.workerId,
    jobId: input.lease.jobId,
    leaseToken: input.lease.leaseToken,
    attempt: input.attempt,
    subject: input.subject(),
  });
  const failed = (error: unknown) =>
    new HandlerError(
      error instanceof NativeSessionBindingError
        ? error.code
        : 'NATIVE_SESSION_ADMISSION_DENIED',
      '当前任务或原生会话的执行授权已变化，请查看任务记录。',
      false,
    );
  const adopted = async (
    value: Awaited<ReturnType<typeof bindJobNativeSession>>,
    descriptor: BindInput['descriptor'],
  ) => {
    await input.onBound?.(value, descriptor);
    return {
      binding: value.binding,
      ...(value.conversation
        ? { generation: value.conversation.generation }
        : {}),
    };
  };
  return {
    prepare: async (request) => {
      try {
        await input.beforeBind?.();
        const value = await prepareJobNativeSession({
          ...lease(),
          nativeSessionId: request.nativeSessionId,
          storageContextKey: request.storageContextKey,
        });
        return {
          ...(value.binding
            ? await adopted(
                {
                  binding: value.binding,
                  conversation: value.conversation,
                },
                value.binding,
              )
            : { binding: null }),
          origin: value.origin,
          executionBinding: value.executionBinding,
          requiresRecovery: value.requiresRecovery,
        };
      } catch (error) {
        throw failed(error);
      }
    },
    bind: async (descriptor) => {
      try {
        await input.beforeBind?.();
        const value = await bindJobNativeSession({
          ...lease(),
          descriptor,
        });
        return await adopted(value, descriptor);
      } catch (error) {
        throw failed(error);
      }
    },
  };
}
