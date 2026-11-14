import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from '@allrice/contracts';
import { EmployeeInstanceError } from '../../../../packages/database/src/employees/employee-instances.ts';
import { EmployeeContentError } from '../../../../packages/database/src/employees/employee-content-model.ts';
import { EmployeeRuntimeContentError } from '../../../../packages/database/src/employees/employee-runtime-content.ts';
import { employeeHubErrorResponse } from './responses';

describe('employee instance content error distinctions', () => {
  it('does not classify historical publication wording as a continuation ban', async () => {
    const response = employeeHubErrorResponse(
      new EmployeeRuntimeContentError(
        '本对话使用的企业资料已撤销或删除，请新建对话。历史记录仍可查看。',
      ),
    );
    expect(response.status).toBe(409);
    expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject({
      code: 'CONFLICT',
      retryable: false,
    });
  });
  it('reports retired text writes without suggesting a retry or changing the error envelope', async () => {
    const response = employeeHubErrorResponse(
      new EmployeeContentError('legacy_method_retired'),
    );
    expect(response.status).toBe(409);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error).toMatchObject({
      code: 'CONFLICT',
      retryable: false,
      message:
        '旧文字工作方法写入已停用，历史内容与回执保留。个人 Workflow 请使用完整包的预览确认入口。',
    });
    expect(body.error.message).not.toContain('重试');
  });
  it('uses the existing protected-default conflict for instance archival', async () => {
    const response = employeeHubErrorResponse(
      new EmployeeInstanceError('default_protected'),
    );
    expect(response.status).toBe(409);
    expect(ApiErrorSchema.parse(await response.json()).error).toMatchObject({
      code: 'DEFAULT_EMPLOYEE_PROTECTED',
      message: 'Rice is the protected default employee',
      retryable: false,
    });
  });

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
