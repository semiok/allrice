import { randomUUID } from 'node:crypto';

import { DataAccessError, QueueError } from '@allrice/database';

export function executionErrorResponse(error: unknown) {
  const requestId = randomUUID();
  let status = 400;
  let code = 'VALIDATION_FAILED';
  let message = 'Execution request validation failed';
  let retryable = false;
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
      code = 'RESOURCE_NOT_FOUND';
      message = 'Run not found';
    }
  } else if (error instanceof QueueError) {
    if (error.code === 'not_found') {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'Run not found';
    } else if (error.code === 'conflict' || error.code === 'lease_lost') {
      status = 409;
      code = 'CONFLICT';
      message = 'Run state changed; refresh and retry';
    } else if (error.code === 'cursor_invalid') {
      status = 400;
      code = 'CURSOR_INVALID';
      message = 'Run event cursor is invalid';
    } else if (error.code === 'policy_denied') {
      status = 403;
      code = 'AUTHORIZATION_DENIED';
      message = 'Frozen execution policy denied this run';
    }
  } else {
    console.error('Unhandled execution request error', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown failure',
    });
    if (error instanceof Error && error.name !== 'ZodError') {
      status = 500;
      code = 'INTERNAL_ERROR';
      message = 'Execution request failed';
      retryable = true;
    }
  }
  return Response.json(
    { error: { code, message, requestId, retryable } },
    { status },
  );
}
