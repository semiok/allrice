import { DataAccessError, listExternalActions } from '@allrice/database';

import { capabilityErrorResponse } from '../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const runId = url.searchParams.get('runId') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 100);
    return Response.json({
      actions: await listExternalActions(context, workspaceId, {
        runId,
        limit,
      }),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
