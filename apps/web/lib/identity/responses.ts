import { IdentityError } from '@allrice/database';

import { apiProblem } from '../api-error-response';

export function identityErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    const authentication = error.code === 'authentication_failed';
    const forbidden =
      error.code === 'portal_account_mismatch' ||
      error.code === 'authorization_denied' ||
      error.code === 'tenant_context_invalid';
    return apiProblem({
      status: authentication ? 401 : forbidden ? 403 : 400,
      code: authentication
        ? 'AUTHENTICATION_REQUIRED'
        : forbidden
          ? 'AUTHORIZATION_DENIED'
          : 'VALIDATION_FAILED',
      message:
        error.code === 'portal_account_mismatch'
          ? '这个账号不属于当前登录入口，请使用对应的员工或管理员入口。'
          : authentication
            ? 'Authentication failed'
            : forbidden
              ? 'Access denied'
              : 'Invitation is invalid or expired',
      retryable: false,
    });
  }
  return apiProblem({
    status: 400,
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed',
    retryable: false,
  });
}
