import { randomUUID } from 'node:crypto';

import { CapabilityRegistryError, DataAccessError } from '@allrice/database';

export function capabilityErrorResponse(error: unknown) {
  const requestId = randomUUID();
  let status = 400;
  let code = 'VALIDATION_FAILED';
  let message = 'Capability request validation failed';
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
      message = 'Capability resource not found';
    }
  } else if (error instanceof CapabilityRegistryError) {
    if (error.code === 'not_found') {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'Capability resource not found';
    } else if (error.code === 'version_conflict') {
      status = 409;
      code = 'VERSION_CONFLICT';
      message = 'Capability revision or slug already exists';
    } else if (error.code === 'acl_denied') {
      status = 403;
      code = 'KNOWLEDGE_ACL_DENIED';
      message = 'Knowledge access is not granted';
    } else {
      status = 422;
      code = 'CAPABILITY_BINDING_INVALID';
      message = 'Capability binding is invalid or crosses a tenant boundary';
    }
  } else if (error instanceof Error && error.name !== 'ZodError') {
    console.error('Unhandled capability request error', {
      name: error.name,
      message: error.message,
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Capability request failed';
  }
  return Response.json(
    { error: { code, message, requestId, retryable: status >= 500 } },
    { status },
  );
}
