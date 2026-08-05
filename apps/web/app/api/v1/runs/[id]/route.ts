import { DataAccessError, getRun } from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    return Response.json({ run: await getRun(context, workspaceId, id) });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
