import { addSkillSourceErrorReason } from '../../../../../../../lib/skills/source-error-reason';
import { DataAccessError, PersonalSkillError } from '@allrice/database';
import { SkillPreviewError } from '@allrice/skill-import';
import { FileArchiveError } from '@allrice/file-archives';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';
import { apiProblem } from '../../../../../../../lib/api-problem';
import { confirmPersonalSkillSource } from '../../../../../../../lib/skills/personal-skill-confirm';
import { readSkillConfirmationRequest } from '../../../../../../../lib/skills/preview-request';

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
    return Response.json(
      await confirmPersonalSkillSource(
        context,
        (await params).id,
        await readSkillConfirmationRequest(request),
        request.signal,
      ),
      { headers },
    );
  } catch (error) {
    let response: Response;
    if (error instanceof SkillPreviewError || error instanceof FileArchiveError)
      response = apiProblem({
        status: 422,
        code: 'VALIDATION_FAILED',
        retryable: false,
        message: '技能预览已失效或内容不完整，请重新读取后确认。',
      });
    else if (error instanceof PersonalSkillError)
      response = apiProblem({
        status: error.code === 'unavailable' ? 404 : 409,
        code:
          error.code === 'unavailable'
            ? 'RESOURCE_NOT_FOUND'
            : 'VERSION_CONFLICT',
        retryable: false,
        message:
          error.code === 'name_conflict'
            ? '技能 name 已存在或与原技能不同，请检查后重新读取。'
            : error.code === 'limit'
              ? '技能数量或版本已达到上限，请先检查当前安装。'
              : '技能版本、绑定或权限已变化，请重新读取后确认。',
      });
    else response = employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return addSkillSourceErrorReason(response, error, 'confirm');
  }
}
