import { UuidSchema } from '@allrice/contracts';
import { DataAccessError, readLocalFileCommand } from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { bridgeErrorResponse } from '../../../../../../lib/bridge/responses';
export const runtime = 'nodejs';
type Route = { params: Promise<{ id: string }> };
async function respond(request: Request, route: Route, cancel: boolean) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    return Response.json(
      await readLocalFileCommand(
        context,
        workspaceId,
        UuidSchema.parse((await route.params).id),
        cancel,
      ),
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (e) {
    return bridgeErrorResponse(e);
  }
}
export const GET = (request: Request, route: Route) =>
  respond(request, route, false);
export const POST = (request: Request, route: Route) =>
  respond(request, route, true);
