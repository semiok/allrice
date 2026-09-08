import { DataAccessError, listBridgeDevices } from '@allrice/database';

import { bridgeErrorResponse } from '../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(response: Response) {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  return response;
}

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return noStore(
      Response.json({
        devices: await listBridgeDevices(context, workspaceId),
      }),
    );
  } catch (error) {
    return noStore(bridgeErrorResponse(error));
  }
}
