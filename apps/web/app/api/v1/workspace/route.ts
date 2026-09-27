import {
  DataAccessError,
  getEmployeeWorkspace,
  getUserPreferences,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    const workspace = await getEmployeeWorkspace(
      context,
      workspaceId ?? undefined,
    );
    return Response.json(
      {
        workspace: {
          ...workspace,
          canAdminister: workspace.canAdminister,
          viewerId: context.actor.type === 'user' ? context.actor.id : null,
          preferences:
            context.actor.type === 'user'
              ? await getUserPreferences(context)
              : undefined,
        },
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
