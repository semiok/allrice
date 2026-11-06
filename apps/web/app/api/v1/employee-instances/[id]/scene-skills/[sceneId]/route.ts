import { PersonalSceneRemoveResponseSchema } from '@allrice/contracts';
import { DataAccessError, removePersonalSceneSkill } from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; sceneId: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id, sceneId } = await params;
    const receipt = await removePersonalSceneSkill(
      context,
      id,
      sceneId,
      await request.json(),
    );
    return Response.json(PersonalSceneRemoveResponseSchema.parse({ receipt }), {
      headers,
    });
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
}
