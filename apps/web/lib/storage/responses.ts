import { randomUUID } from 'node:crypto';

import { DataAccessError } from '@allrice/database';
import { SignedAccessError } from '@allrice/storage';

export function storageErrorResponse(error: unknown) {
  const requestId = randomUUID();
  let status = 400;
  let code = 'VALIDATION_FAILED';
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
  } else {
    console.error('Unhandled storage request error', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown failure',
    });
  }
  return Response.json(
    { error: { code, message, requestId, retryable: false } },
    { status },
  );
}
