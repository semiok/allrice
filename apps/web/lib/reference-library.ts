import { DataAccessError, ReferenceLibraryError } from '@allrice/database';
import { getRequestContext } from './identity/session';
import { storageErrorResponse } from './storage/responses';
import { apiProblem } from './api-error-response';

export async function referenceContext(request: Request) {
  const context = await getRequestContext(request);
  if (!context) throw new DataAccessError('authentication_required');
  return context;
}
export function referenceError(error: unknown) {
  if (error instanceof ReferenceLibraryError) {
    const message = {
      version_conflict: '资料版本已更新，请刷新后重试。',
      request_conflict: '同一次保存的内容发生变化，请重新选择文件。',
      invalid_content: '文件为空、格式无效或超过 50 MiB。',
      processing_busy: '资料正在处理，请稍后刷新。',
    }[error.code];
    return apiProblem({
      status: error.code === 'invalid_content' ? 400 : 409,
      code: error.code === 'invalid_content' ? 'VALIDATION_FAILED' : 'CONFLICT',
      message,
    });
  }
  return storageErrorResponse(error);
}
export const referenceHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
