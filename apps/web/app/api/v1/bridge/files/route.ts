import { DataAccessError, enqueueLocalFileCommand } from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { bridgeErrorResponse } from '../../../../../lib/bridge/responses';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      await enqueueLocalFileCommand(context, await request.json()),
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (e) {
    return bridgeErrorResponse(e);
  }
}
