import { CodexSubscriptionError } from '@allrice/database';
import {
  DataAccessError,
  EmployeeAccessBusyError,
  EmployeeHubError,
  EmployeeInstanceError,
  EmployeeContentError,
  EmployeeRuntimeContentError,
} from '@allrice/database';

import {
  apiProblem,
  type ApiProblemCode,
  isRequestValidationError,
} from '../api-error-response';

export function employeeHubErrorResponse(error: unknown) {
  if (error instanceof EmployeeAccessBusyError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: '任务正在更新执行状态，本次修改未生效。请稍后重试。',
      retryable: true,
    });
  if (error instanceof EmployeeRuntimeContentError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: error.message,
      retryable: false,
    });
  if (error instanceof EmployeeContentError)
    return apiProblem({
      status: 409,
      code:
        error.code === 'version_conflict' || error.code === 'request_conflict'
          ? 'VERSION_CONFLICT'
          : 'CONFLICT',
      message:
        error.code === 'validation_required'
          ? '请先校验当前草稿，再启用。'
          : error.code === 'validation_failed'
            ? '草稿存在不可用来源或冲突，请查看校验结果。'
            : error.code === 'source_changed'
              ? '内容来源或继承版本已变化，请重新校验。'
              : '内容版本或请求标识已变化，请读取最新版本后重试。',
      retryable: false,
    });
  if (error instanceof EmployeeInstanceError)
    return apiProblem({
      status: 409,
      code:
        error.code === 'instance_archived' ? 'CONFLICT' : 'VERSION_CONFLICT',
      message:
        error.code === 'instance_archived'
          ? 'AI 员工已归档，可以查看历史；恢复后才能继续工作。'
          : '员工配置已变化，或请求标识被用于不同修改。请读取最新版本后重试。',
      retryable: false,
    });
  if (error instanceof CodexSubscriptionError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: error.message,
      retryable: false,
    });
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
      message = '当前员工的模型与认证配置不匹配，请检查已发布版本的模型设置。';
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
