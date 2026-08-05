import { DataAccessError, getEmployeeWorkspace } from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    return Response.json({
      workspace: await getEmployeeWorkspace(context, workspaceId ?? undefined),
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
