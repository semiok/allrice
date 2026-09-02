import { DataAccessError } from '@allrice/database';
import { SignedAccessError } from '@allrice/storage';

import {
  apiProblem,
  type ApiProblemCode,
  isRequestValidationError,
} from '../api-error-response';

export function storageErrorResponse(error: unknown) {
  let status = 400;
  let code: ApiProblemCode = 'VALIDATION_FAILED';
  let message = 'Storage request validation failed';
  if (error instanceof DataAccessError) {
    if (error.code === 'authentication_required') {
      status = 401;
      code = 'AUTHENTICATION_REQUIRED';
      message = 'Authentication required';
    } else if (error.code === 'authorization_denied') {
      status = 403;
      code = 'AUTHORIZATION_DENIED';
      message = 'Access denied';
    } else if (error.code === 'not_found') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'Storage object not found';
    } else if (error.code === 'quota_exceeded') {
      status = 413;
      code = 'QUOTA_EXCEEDED';
      message = 'Workspace storage quota exceeded';
    } else if (error.code === 'grant_invalid') {
      status = 403;
      code = 'SIGNED_ACCESS_DENIED';
      message = 'Signed access denied';
    }
  } else if (error instanceof SignedAccessError) {
    status = 403;
    code = 'SIGNED_ACCESS_DENIED';
    message = 'Signed access denied';
  } else if (!isRequestValidationError(error)) {
    console.error('Unhandled storage request error', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown failure',
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Storage request failed';
  }
  return apiProblem({ status, code, message });
}
