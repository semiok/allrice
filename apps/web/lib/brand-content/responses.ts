import { BrandContentError, WorkflowPackageError } from '@allrice/database';
import { apiProblem } from '../api-error-response';
import { employeeHubErrorResponse } from '../employeehub/responses';

export function brandContentErrorResponse(error: unknown) {
  if (error instanceof BrandContentError) {
    if (error.code === 'reminder_unavailable')
      return apiProblem({
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        message: '到点提醒暂不可用，本次未登记；原排期已保留。',
        retryable: false,
      });
    const missing = error.code === 'not_found';
    const denied = error.code === 'authority_denied';
    return apiProblem({
      status: missing ? 404 : denied ? 403 : 409,
      code: missing
        ? 'RESOURCE_NOT_FOUND'
        : denied
          ? 'AUTHORIZATION_DENIED'
          : 'CONFLICT',
      message: denied
        ? '当前账号或操作方式无权更改这份业务记录。'
        : missing
          ? '未找到当前员工可用的品牌业务记录。'
          : ({
              version_conflict:
                '记录已更新，请刷新后按最新版本继续；本次没有覆盖。',
              request_conflict:
                '这个请求标识已用于另一项操作，请核对原结果后再提交。',
              invalid_state:
                '当前业务状态不允许这项操作，请核对选题、稿件或准确版本审核。',
              source_unavailable: '固定资料或文件已不可用，未换用其他来源。',
              source_changed: '固定资料或文件校验值已变化，未保存本次修改。',
              parent_mismatch:
                '修订稿必须续接当前稿件的准确版本，本次未替换原稿。',
              source_reference_invalid:
                '来源引用与当前品牌、稿件或员工不一致。',
              workflow_pin_required: '本次业务写入缺少已授权的准确流程版本。',
              receipt_invalid:
                '请提供实际发布的链接、发布人和时间，计划不能作为发布回执。',
              reminder_unconfirmed:
                '尚未读到这次统一调度的真实执行回执，提醒状态保持待核实。',
            }[error.code] ?? '记录状态已变化，请刷新后核对。'),
      retryable: false,
    });
  }
  if (error instanceof WorkflowPackageError)
    return apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: '流程包、方法或授权已变化，请刷新并核对当前绑定版本。',
      retryable: false,
    });
  return employeeHubErrorResponse(error);
}
