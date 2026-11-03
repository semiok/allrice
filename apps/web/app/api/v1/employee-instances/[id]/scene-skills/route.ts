import { EmployeeSceneSkillPinSchema } from '@allrice/contracts';
import {
  DataAccessError,
  listEmployeeSceneSkills,
  getEmployeeSceneSkill,
  getEmployeeSceneSkillResource,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';

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
