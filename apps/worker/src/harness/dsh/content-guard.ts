import { HandlerError } from '../../errors.js';

/** A database/check failure is not evidence that the user's sources expired.
 * Stop this dispatch and retain its cause without replaying a paid Run. */
export function contentGuardFailure(error: unknown): HandlerError {
  if (error instanceof HandlerError) return error;
  return new HandlerError(
    'EMPLOYEE_CONTENT_CHECK_UNAVAILABLE',
    '工作资料检查暂时遇到系统故障，已有内容已保留，请稍后重试。',
    false,
    { cause: error },
  );
}
