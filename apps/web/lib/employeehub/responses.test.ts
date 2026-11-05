import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from '@allrice/contracts';
import { EmployeeInstanceError } from '../../../../packages/database/src/employees/employee-instances.ts';
import { EmployeeContentError } from '../../../../packages/database/src/employees/employee-content-model.ts';
import { employeeHubErrorResponse } from './responses';

describe('employee instance content error distinctions', () => {
  it('identifies archived instances without changing the HTTP conflict or safe message', async () => {
    const response = employeeHubErrorResponse(
      new EmployeeInstanceError('instance_archived'),
    );
    expect(response.status).toBe(409);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error).toMatchObject({
      code: 'EMPLOYEE_INSTANCE_ARCHIVED',
      message: 'AI 员工已归档，可以查看历史；恢复后才能继续工作。',
      retryable: false,
    });
  });

  it('retains ordinary content and request conflicts as separate existing codes', async () => {
    for (const [cause, code] of [
      [new EmployeeInstanceError('instance_conflict'), 'VERSION_CONFLICT'],
      [new EmployeeContentError('source_changed'), 'CONFLICT'],
      [new EmployeeContentError('request_conflict'), 'VERSION_CONFLICT'],
    ] as const) {
      const response = employeeHubErrorResponse(cause);
      expect(response.status).toBe(409);
      const body = ApiErrorSchema.parse(await response.json());
      expect(body.error).toMatchObject({ code, retryable: false });
      expect(body.error.code).not.toBe('EMPLOYEE_INSTANCE_ARCHIVED');
    }
  });
});
