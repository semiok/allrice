import { randomUUID } from 'node:crypto';

import { DataAccessError, SkillHubError } from '@allrice/database';

export function skillHubErrorResponse(error: unknown) {
  const requestId = randomUUID();
  let status = 400;
  let code = 'VALIDATION_FAILED';
  let message = 'SkillHub request validation failed';
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
      message = 'SkillHub resource not found';
    }
  } else if (error instanceof SkillHubError) {
    if (error.code === 'not_found') {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'Skill or installation not found';
    } else if (error.code === 'version_conflict') {
      status = 409;
      code = 'VERSION_CONFLICT';
      message = 'This immutable skill version already exists';
    } else if (error.code === 'capability_denied') {
      status = 403;
      code = 'CAPABILITY_DENIED';
      message = 'Requested skill capability was not granted';
    } else {
      status = 422;
      code = 'ARTIFACT_INVALID';
      message = 'Skill artifact is not ready and immutable';
    }
  } else if (error instanceof Error && error.name !== 'ZodError') {
    console.error('Unhandled SkillHub request error', {
      name: error.name,
      message: error.message,
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'SkillHub request failed';
  }
  return Response.json(
    { error: { code, message, requestId, retryable: status >= 500 } },
    { status },
  );
}
