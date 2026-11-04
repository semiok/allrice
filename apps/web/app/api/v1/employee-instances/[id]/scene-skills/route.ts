import {
  EmployeeSceneSkillPinSchema,
  PersonalSceneSkillQuerySchema,
} from '@allrice/contracts';
import {
  DataAccessError,
  listEmployeeSceneSkills,
  getEmployeeSceneSkill,
  getEmployeeSceneSkillResource,
  getEmployeeInstance,
  listPersonalSceneSkills,
  getPersonalSceneSkill,
  getPersonalSceneSkillResource,
  savePersonalSceneSkill,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = new URL(request.url).searchParams;
    const scope = {
      ...context,
      workspaceId: query.get('workspaceId') ?? context.workspaceId,
    };
    const instanceId = (await params).id;
    const instance = await getEmployeeInstance(scope, instanceId);
    if (instance.kind === 'custom') {
      const selection = PersonalSceneSkillQuerySchema.parse(
        Object.fromEntries(query),
      );
      const result = selection.contentRef
        ? await getPersonalSceneSkillResource(
            scope,
            instanceId,
            selection.contentRef,
            selection.resourcePath!,
          )
        : selection.sceneId
          ? await getPersonalSceneSkill(scope, instanceId, selection.sceneId)
          : await listPersonalSceneSkills(scope, instanceId);
      return Response.json(result, {
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    const fields = [
      'setId',
      'revisionId',
      'sceneId',
      'sourceRevisionId',
    ] as const;
    const hasPin =
      fields.some((field) => query.has(field)) || query.has('resourcePath');
    const pin = hasPin
      ? EmployeeSceneSkillPinSchema.parse(
          Object.fromEntries(fields.map((field) => [field, query.get(field)])),
        )
      : null;
    const result = pin
      ? query.has('resourcePath')
        ? await getEmployeeSceneSkillResource(
            scope,
            instanceId,
            pin,
            query.get('resourcePath')!,
          )
        : await getEmployeeSceneSkill(scope, instanceId, pin)
      : await listEmployeeSceneSkills(scope, instanceId);
    return Response.json(result, {
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const receipt = await savePersonalSceneSkill(
      context,
      (await params).id,
      await request.json(),
    );
    return Response.json(
      { receipt },
      {
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}
