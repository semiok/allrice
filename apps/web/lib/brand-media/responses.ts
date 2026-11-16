import {
  BrandMediaError,
  ArtifactReviewError,
  QueueError,
  ReferenceSelectionUnavailableError,
  EmployeeModuleError,
  IdentityError,
} from '@allrice/database';
import { referenceSelectionError } from '../reference-library';
import { apiProblem, isRequestValidationError } from '../api-error-response';
import { brandContentErrorResponse } from '../brand-content/responses';

export function brandMediaErrorResponse(error: unknown) {
  if (error instanceof ReferenceSelectionUnavailableError)
    return referenceSelectionError(error);
  if (error instanceof ArtifactReviewError || error instanceof QueueError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message:
        error.code === 'input_id_conflict'
          ? '相同提交编号已用于另一项生成，请核对原结果。'
          : '当前任务或固定版本已变化，请刷新后重试。',
      retryable: false,
    });
  if (error instanceof IdentityError)
    return apiProblem({
      status:
        error.code === 'tenant_context_invalid' ||
        error.code === 'authorization_denied'
          ? 403
          : 401,
      code:
        error.code === 'tenant_context_invalid' ||
        error.code === 'authorization_denied'
          ? 'AUTHORIZATION_DENIED'
          : 'AUTHENTICATION_REQUIRED',
      message: '当前登录身份无权访问所选工作区，请重新核对。',
      retryable: false,
    });
  if (isRequestValidationError(error))
    return apiProblem({
      status: 422,
      code: 'VALIDATION_FAILED',
      message: '请求格式不正确，请核对准确版本、记录及操作参数。',
      retryable: false,
    });
  if (error instanceof EmployeeModuleError)
    return apiProblem({
      status: error.code === 'module_unavailable' ? 403 : 409,
      code:
        error.code === 'module_unavailable'
          ? 'AUTHORIZATION_DENIED'
          : 'VERSION_CONFLICT',
      message:
        error.code === 'module_unavailable'
          ? '当前员工尚未添加这个插件，或绑定已撤销。'
          : '插件的准确版本或绑定已变化，请核对当前版本；本次未自动升级。',
      retryable: false,
    });
  if (error instanceof BrandMediaError)
    return apiProblem({
      status: error.code === 'not_found' ? 404 : 409,
      code: error.code === 'not_found' ? 'RESOURCE_NOT_FOUND' : 'CONFLICT',
      message: {
        not_found: '未找到当前员工的品牌自媒体记录。',
        version_conflict: '记录已更新，请刷新后继续；本次没有覆盖。',
        request_conflict: '这个请求标识已用于另一项操作，请核对原结果。',
        invalid_state: '当前状态不允许这项操作，已发布文章请先改回已排期。',
        source_unavailable:
          '固定资料、来源记录或交付文件已不可用，请重新核对。',
        source_changed: '固定文件校验值已变化，本次没有保存修改。',
        source_reference_invalid: '引用与准确资料版本、文件或当前员工不一致。',
      }[error.code],
      retryable: false,
    });
  return brandContentErrorResponse(error);
}
