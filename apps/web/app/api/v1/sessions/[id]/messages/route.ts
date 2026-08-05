import { DataAccessError, sendChatMessage } from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const result = await sendChatMessage(
      context,
      workspaceId,
      id,
      await request.json(),
    );
    return Response.json(result, { status: result.created ? 202 : 200 });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
