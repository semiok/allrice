import { UuidSchema } from '@allrice/contracts';
import {
  DataAccessError,
  PersonalSkillError,
  getEmployeeSkillCatalog,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';
import { apiProblem } from '../../../../../../lib/api-problem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    return Response.json(
      await getEmployeeSkillCatalog(
        { ...context, workspaceId },
        (await params).id,
      ),
      { headers },
    );
  } catch (error) {
    const response =
      error instanceof PersonalSkillError
        ? apiProblem({
            status: 409,
            code: 'VERSION_CONFLICT',
            retryable: false,
            message: '技能内容或绑定已变化，请刷新后重试。',
          })
        : employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
}
