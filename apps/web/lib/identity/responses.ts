import { randomUUID } from 'node:crypto';

import { IdentityError } from '@allrice/database';

export function identityErrorResponse(error: unknown) {
  const requestId = randomUUID();
  if (error instanceof IdentityError) {
    const authentication = error.code === 'authentication_failed';
    const forbidden =
      error.code === 'authorization_denied' ||
      error.code === 'tenant_context_invalid';
    return Response.json(
      {
        error: {
          code: authentication
            ? 'AUTHENTICATION_REQUIRED'
            : forbidden
              ? 'AUTHORIZATION_DENIED'
              : 'VALIDATION_FAILED',
          message: authentication
            ? 'Authentication failed'
            : forbidden
              ? 'Access denied'
              : 'Invitation is invalid or expired',
          requestId,
          retryable: false,
        },
      },
      { status: authentication ? 401 : forbidden ? 403 : 400 },
    );
  }
  return Response.json(
    {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        requestId,
        retryable: false,
      },
    },
    { status: 400 },
  );
}
