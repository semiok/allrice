import { PersonalSceneContentQuerySchema } from '@allrice/contracts';
import { DataAccessError, inspectPersonalSceneSkill } from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = PersonalSceneContentQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(
      await inspectPersonalSceneSkill(
        { ...context, workspaceId: query.workspaceId ?? context.workspaceId },
        (await params).id,
        query.contentRef,
      ),
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
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  }
}
