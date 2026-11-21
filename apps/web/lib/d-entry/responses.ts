import { employeeHubErrorResponse } from '../employeehub/responses';
import { executionErrorResponse } from '../execution/responses';
import { EmployeeInstanceError } from '@allrice/database';
import { apiProblem } from '../api-error-response';
import { DEntryDependencyUnavailable } from './release-policy';

export function dEntryErrorResponse(error: unknown) {
  if (error instanceof DEntryDependencyUnavailable)
    return apiProblem({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'The selected entry is not available',
      retryable: false,
    });
  return error instanceof EmployeeInstanceError
    ? employeeHubErrorResponse(error)
    : executionErrorResponse(error);
}
