import {
  DataAccessError,
  getBridgeSettings,
  updateBridgeSettings,
} from '@allrice/database';
import { bridgeErrorResponse } from '../../../../../../../lib/bridge/responses';
import { getRequestContext } from '../../../../../../../lib/identity/session';

export const runtime = 'nodejs';
type Route = { params: Promise<{ id: string }> };
async function respond(request: Request, route: Route, update: boolean) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    return Response.json(
      update
        ? await updateBridgeSettings(
            context,
            workspaceId,
            id,
            await request.json(),
          )
        : await getBridgeSettings(context, workspaceId, id),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return bridgeErrorResponse(error);
  }
}
export const GET = (request: Request, route: Route) =>
  respond(request, route, false);
export const PATCH = (request: Request, route: Route) =>
  respond(request, route, true);
