import { NativeOnceProductError } from '@allrice/database';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';

export function onceErrorResponse(error: unknown) {
  if (error instanceof NativeOnceProductError) {
    const messages = {
      disabled: '定时任务暂不可用，请稍后再试。',
      time_invalid: '请选择未来一年内的执行时间。',
      request_conflict: '该请求已保存为另一项任务，请刷新后查看。',
      binding_conflict: '任务状态已变化，请刷新后查看。',
      lease_lost: '任务状态正在更新，请稍后查看。',
    };
    return Response.json(
      { error: error.code, message: messages[error.code] },
      { status: error.code === 'disabled' ? 503 : 409 },
    );
  }
  return storageErrorResponse(error);
}
