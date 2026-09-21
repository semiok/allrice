import {
  DataAccessError,
  IdentityError,
  QueueError,
  WorkflowRuntimeError,
  UsageBudgetReviewError,
} from '@allrice/database';

import {
  apiProblem,
  type ApiProblemCode,
  isRequestValidationError,
} from '../api-error-response';

const publicationConflicts: Readonly<Record<string, string>> = {
  platform_employee_published_revision_immutable:
    '已发布版本不能重新编译。请先保存为新草稿，再编译和试用。',
  platform_employee_draft_unavailable: '当前草稿不可用，请刷新并保存新草稿。',
  platform_employee_publish_snapshot_changed:
    '待发布的配置或资源版本已变化，请刷新并重新试用当前版本。',
  platform_employee_publish_workspace_unavailable:
    '发布目标工作区已不可用，请刷新并重新选择。',
  platform_employee_publish_provider_unavailable:
    '模型服务健康状态已变化，请确认服务恢复后重新发布。',
  platform_employee_publish_test_unavailable:
    '当前确切运行包没有有效的成功试用记录，请重新试用后发布。',
};

export function executionErrorResponse(error: unknown) {
  if (error instanceof UsageBudgetReviewError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      retryable: false,
      message:
        error.code === 'USAGE_REVIEW_CONFLICT'
          ? '该异常用量已审批或原始记录已变化，请刷新后核对。'
          : '仅可处理已结束、无活动任务的普通订阅异常；助手悬挂用量或 API 用量须另行核对。',
    });
  if (
    error instanceof Error &&
    Object.hasOwn(publicationConflicts, error.message)
  )
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: publicationConflicts[error.message]!,
      retryable: false,
    });
  let status = 400;
  let code: ApiProblemCode = 'VALIDATION_FAILED';
  let message = 'Execution request validation failed';
  let retryable = false;
  if (error instanceof IdentityError) {
    if (error.code === 'authentication_failed') {
      status = 401;
      code = 'AUTHENTICATION_REQUIRED';
      message = 'Authentication required';
    } else if (
      error.code === 'authorization_denied' ||
      error.code === 'tenant_context_invalid'
    ) {
      status = 403;
      code = 'AUTHORIZATION_DENIED';
      message = 'Access denied';
    }
  } else if (error instanceof DataAccessError) {
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
  } else if (error instanceof WorkflowRuntimeError) {
    if (error.code === 'not_found') {
      status = 404;
      code = 'RESOURCE_NOT_FOUND';
      message = 'Workflow run not found';
    } else if (error.code === 'conflict' || error.code === 'lease_lost') {
      status = 409;
      code = 'CONFLICT';
      message = 'Workflow state changed; refresh and retry';
    } else if (error.code === 'approval_required') {
      status = 409;
      code = 'APPROVAL_REQUIRED';
      message = 'Workflow is waiting for approval';
    } else if (error.code === 'needs_attention') {
      status = 409;
      code = 'WORKFLOW_NEEDS_ATTENTION';
      message = 'Workflow requires manual intervention';
    }
  } else if (!isRequestValidationError(error)) {
    console.error('Unhandled execution request error', {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'Unknown failure',
    });
    status = 500;
    code = 'INTERNAL_ERROR';
    message = 'Execution request failed';
    retryable = true;
  }
  return apiProblem({ status, code, message, retryable });
}
