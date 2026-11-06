import { addSkillSourceErrorReason } from './source-error-reason';
import { EmployeeContentError, PersonalSkillError } from '@allrice/database';
import { FileArchiveError } from '@allrice/file-archives';
import {
  PersonalSkillSourceError,
  SkillPreviewError,
} from '@allrice/skill-import';
import { employeeHubErrorResponse } from '../employeehub/responses';
import { apiProblem } from '../api-problem';

export function sceneSourceErrorResponse(
  error: unknown,
  operation: 'preview' | 'confirm',
) {
  let response: Response;
  if (error instanceof SkillPreviewError)
    response = apiProblem({
      status: 422,
      code: 'VALIDATION_FAILED',
      retryable: false,
      message: '技能预览已失效或内容不完整，请重新读取后确认。',
    });
  else if (error instanceof PersonalSkillSourceError)
    response = apiProblem({
      status: 422,
      code: 'VALIDATION_FAILED',
      retryable: false,
      message:
        '读不到这个仓库。目前只支持公开仓库，请检查链接和根目录的 SKILL.md。',
    });
  else if (
    error instanceof FileArchiveError ||
    error instanceof PersonalSkillError ||
    (error instanceof Error &&
      [
        'personal_skill_package_missing_skill',
        'personal_skill_package_unsafe_path',
        'personal_skill_package_path_conflict',
        'personal_skill_package_candidate_limit',
      ].includes(error.message))
  )
    response = employeeHubErrorResponse(
      new EmployeeContentError('workflow_invalid'),
    );
  else response = employeeHubErrorResponse(error);
  Object.entries(sceneSourceHeaders).forEach(([key, value]) =>
    response.headers.set(key, value),
  );
  return addSkillSourceErrorReason(response, error, operation);
}
export const sceneSourceHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
