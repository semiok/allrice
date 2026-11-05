import { addSkillSourceErrorReason } from '../../../../../../../lib/skills/source-error-reason';
import { DataAccessError, PersonalSkillError } from '@allrice/database';
import { FileArchiveError } from '@allrice/file-archives';
import {
  PersonalSkillSourceError,
  SkillPreviewError,
} from '@allrice/skill-import';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';
import { apiProblem } from '../../../../../../../lib/api-problem';
import { previewPersonalSkillSource } from '../../../../../../../lib/skills/personal-skill-preview';
import { readSkillPreviewRequest } from '../../../../../../../lib/skills/preview-request';

export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { input, archive } = await readSkillPreviewRequest(request);
    return Response.json(
      await previewPersonalSkillSource(
        context,
        (await params).id,
        input,
        archive,
        request.signal,
      ),
      { headers },
    );
  } catch (error) {
    let response: Response;
    if (error instanceof SkillPreviewError) {
      response = apiProblem({
        status:
          error.code === 'version_conflict' || error.code === 'name_mismatch'
            ? 409
            : 422,
        code:
          error.code === 'version_conflict'
            ? 'VERSION_CONFLICT'
            : 'VALIDATION_FAILED',
        message:
          error.code === 'version_conflict'
            ? '技能版本或绑定已变化，请重新读取。'
            : error.code === 'name_mismatch'
              ? '新包的 name 与当前技能不同，不能用于更新。'
              : '无法读取这个技能包，请检查根目录的 SKILL.md 和文件限制。',
        retryable: false,
      });
    } else if (error instanceof PersonalSkillSourceError) {
      response = apiProblem({
        status: 422,
        code: 'VALIDATION_FAILED',
        message:
          '读不到这个仓库。目前只支持公开仓库，请检查链接和根目录的 SKILL.md。',
        retryable: false,
      });
    } else if (
      error instanceof FileArchiveError ||
      error instanceof PersonalSkillError ||
      (error instanceof Error &&
        [
          'personal_skill_package_missing_skill',
          'personal_skill_package_unsafe_path',
          'personal_skill_package_path_conflict',
          'personal_skill_package_candidate_limit',
        ].includes(error.message))
    ) {
      // Exact system error identifiers, never matching user intent or consent.
      response = apiProblem({
        status: 422,
        code: 'VALIDATION_FAILED',
        message: '无法读取这个技能包，请检查根目录的 SKILL.md 和文件限制。',
        retryable: false,
      });
    } else response = employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return addSkillSourceErrorReason(response, error, 'preview');
  }
}
