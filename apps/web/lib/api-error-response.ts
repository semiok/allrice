import { randomUUID } from 'node:crypto';

import { DataAccessError } from '@allrice/database';

export function apiErrorResponse(error: unknown) {
  const requestId = randomUUID();
  let status = 400;
  let code = 'VALIDATION_FAILED';
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
  } else if (error instanceof Error && error.name !== 'ZodError') {
    console.error('Unhandled API request error', {
      name: error.name,
      message: error.message,
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Request failed';
  }
  return Response.json(
    { error: { code, message, requestId, retryable: status >= 500 } },
    { status },
  );
}
