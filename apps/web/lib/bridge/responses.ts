import { BridgeDataError, DataAccessError } from '@allrice/database';

import {
  apiProblem,
  type ApiProblemCode,
  isRequestValidationError,
} from '../api-error-response';

export function bridgeErrorResponse(error: unknown) {
  let status = 400;
  let code: ApiProblemCode = 'BRIDGE_REQUEST_INVALID';
  let message = 'Rice Bridge request is invalid';
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
    } else {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'Bridge resource not found';
    }
  } else if (error instanceof BridgeDataError) {
    if (error.code === 'device_unauthorized') {
      status = 401;
      code = 'AUTHENTICATION_REQUIRED';
      message = 'Bridge device credential is invalid or revoked';
    } else if (error.code === 'pairing_invalid') {
      status = 403;
      code = 'BRIDGE_REQUEST_INVALID';
      message = 'Pairing code is invalid, expired, or already used';
    } else if (error.code === 'device_offline') {
      status = 503;
      code = 'DEPENDENCY_UNAVAILABLE';
      message = 'Bridge device is offline';
      retryable = true;
    } else if (error.code === 'lease_lost') {
      status = 409;
      code = 'CONFLICT';
      message = 'Bridge command lease is no longer valid';
    } else if (error.code === 'result_too_large') {
      status = 413;
      code = 'QUOTA_EXCEEDED';
      message = 'Bridge command result is too large';
    } else {
      status = 409;
      code = 'CONFLICT';
      message = 'Bridge command is unavailable';
      retryable = true;
    }
  } else if (!isRequestValidationError(error)) {
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Rice Bridge request failed';
    console.error('Unhandled Rice Bridge request error', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown failure',
    });
  }
  return apiProblem({ status, code, message, retryable });
}
