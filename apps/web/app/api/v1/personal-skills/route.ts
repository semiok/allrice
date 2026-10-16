import {
  DataAccessError,
  PersonalSkillError,
  listPersonalSkills,
  managePersonalSkill,
  personalSkillHistory,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    const installationId = new URL(request.url).searchParams.get(
      'installationId',
    );
    if (installationId)
      return Response.json(
        await personalSkillHistory(
          { ...context, workspaceId },
          UuidSchema.parse(installationId),
        ),
        { headers },
      );
    return Response.json(
      { skills: await listPersonalSkills({ ...context, workspaceId }) },
      { headers },
    );
  } catch (error) {
    if (error instanceof PersonalSkillError)
      return Response.json(
        { message: '技能版本不存在或当前不可访问。' },
        { status: 404, headers },
      );
    return employeeHubErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { skill: await managePersonalSkill(context, await request.json()) },
      { headers },
    );
  } catch (error) {
    if (error instanceof PersonalSkillError)
      return Response.json(
        {
          message:
            error.code === 'limit'
              ? '当前员工最多启用 8 个个人技能。请先停用不需要的技能。'
              : '技能状态或权限已变化，请刷新后重试。',
        },
        { status: 409, headers },
      );
    return employeeHubErrorResponse(error);
  }
}
