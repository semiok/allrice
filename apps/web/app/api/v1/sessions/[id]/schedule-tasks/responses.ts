import { NativeRecurringProductError } from '@allrice/database';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';

export function recurringErrorResponse(error: unknown) {
  if (error instanceof NativeRecurringProductError) {
    const messages: Record<NativeRecurringProductError['code'], string> = {
      disabled: '周期任务暂不可用，请稍后再试。',
      request_conflict: '该请求已有不同内容，请读取原请求结果。',
      binding_conflict: '任务状态已变化，请重新读取。',
      lease_lost: '任务状态正在更新，请稍后查看。',
      limit: '周期任务数量已达到上限，请先整理已有任务。',
      intent_required: '请明确说明执行周期或每日时间、时区以及具体工作。',
      rule_mismatch: '周期参数与当前用户要求不一致，请核对后重新提交。',
    };
    return Response.json(
      { error: error.code, message: messages[error.code] },
      {
        status:
          error.code === 'disabled' ? 503 : error.code === 'limit' ? 429 : 409,
      },
    );
  }
  return storageErrorResponse(error);
}
export function taskQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  for (const key of query.keys())
    if (query.getAll(key).length !== 1)
      throw new SyntaxError('Duplicate task query');
  return Object.fromEntries(query);
}
