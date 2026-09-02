import { DataAccessError } from '@allrice/database';

import { apiProblem, type ApiProblemCode } from './api-problem';

export {
  apiProblem,
  authenticationRequiredProblem,
  authorizationDeniedProblem,
} from './api-problem';
export type { ApiProblemCode, ApiProblemOptions } from './api-problem';

export function isRequestValidationError(error: unknown) {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.name === 'ZodError')
  );
}

export function apiErrorResponse(error: unknown) {
  let status = 400;
  let code: ApiProblemCode = 'VALIDATION_FAILED';
  let message = 'Request validation failed';
  if (error instanceof DataAccessError) {
    if (error.code === 'authentication_required') {
      status = 401;
      code = 'AUTHENTICATION_REQUIRED';
      message = 'Authentication required';
    } else if (error.code === 'authorization_denied') {
      status = 403;
      code = 'AUTHORIZATION_DENIED';
      message = 'Administrator access required';
    } else {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'Resource not found';
    }
  } else if (error instanceof Error && !isRequestValidationError(error)) {
    console.error('Unhandled API request error', {
      name: error.name,
      message: error.message,
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Request failed';
  }
  return apiProblem({ status, code, message });
}
