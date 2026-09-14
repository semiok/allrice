import { DataAccessError, cancelRun } from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  if (!sameOriginBrowserWrite(request))
    return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403 });
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    return Response.json({
      run: await cancelRun(context, workspaceId, id, await request.json()),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
