import { DataAccessError, EmployeeHubError } from '@allrice/database';

import {
  apiProblem,
  type ApiProblemCode,
  isRequestValidationError,
} from '../api-error-response';

export function employeeHubErrorResponse(error: unknown) {
  let status = 400;
  let code: ApiProblemCode = 'VALIDATION_FAILED';
  let message = 'EmployeeHub request validation failed';
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
      message = 'AI employee resource not found';
    }
  } else if (error instanceof EmployeeHubError) {
    if (error.code === 'not_found') {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'AI employee resource not found';
    } else if (error.code === 'version_conflict') {
      status = 409;
      code = 'VERSION_CONFLICT';
      message = 'Employee version publication conflicted';
    } else if (error.code === 'skill_not_installed') {
      status = 409;
      code = 'SKILL_NOT_INSTALLED';
      message = 'Every selected skill version must be installed and enabled';
    } else if (error.code === 'default_protected') {
      status = 409;
      code = 'DEFAULT_EMPLOYEE_PROTECTED';
      message = 'Rice is the protected default employee';
    } else if (error.code === 'assignment_invalid') {
      status = 422;
      code = 'EMPLOYEE_ASSIGNMENT_INVALID';
      message = 'Every assignee must be an active workspace member';
    } else {
      status = 422;
      code = 'PROVIDER_INVALID';
      message = 'This employee version cannot execute with Codex';
    }
  } else if (error instanceof Error && !isRequestValidationError(error)) {
    console.error('Unhandled EmployeeHub request error', {
      name: error.name,
      message: error.message,
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'EmployeeHub request failed';
  }
  return apiProblem({ status, code, message });
}
