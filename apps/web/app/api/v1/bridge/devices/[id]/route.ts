import { DataAccessError, revokeBridgeDevice } from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    await revokeBridgeDevice(context, workspaceId, (await route.params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
