import { DataAccessError, listDeliverableVersions } from '@allrice/database';

import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    return Response.json({
      versions: await listDeliverableVersions({
        context,
        workspaceId,
        objectId: id,
      }),
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
