import { IdentityError } from '@allrice/database';

import { apiProblem, isRequestValidationError } from '../api-error-response';

export function identityErrorResponse(error: unknown) {
  if (error instanceof IdentityError) {
    const authentication = error.code === 'authentication_failed';
    return apiProblem({
      status: authentication ? 401 : 403,
      code: authentication ? 'AUTHENTICATION_REQUIRED' : 'AUTHORIZATION_DENIED',
      message:
        error.code === 'portal_account_mismatch'
          ? '这个账号不属于当前登录入口，请使用对应的员工或管理员入口。'
          : authentication
            ? 'Authentication failed'
            : 'Access denied',
      retryable: false,
    });
  }
  if (isRequestValidationError(error))
    return apiProblem({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      retryable: false,
    });
  // A database or runtime failure is not the person's input; say so.
  console.error('Unhandled identity request error', {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : 'Unknown failure',
  });
  return apiProblem({
    status: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'Identity service is temporarily unavailable',
    retryable: true,
  });
}
