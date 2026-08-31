import {
  DataAccessError,
  requestBridgeWorkspaceSelection,
} from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../../lib/identity/session';

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
    return Response.json(
      {
        request: await requestBridgeWorkspaceSelection(
          context,
          workspaceId,
          (await route.params).id,
        ),
      },
      { status: 202 },
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
