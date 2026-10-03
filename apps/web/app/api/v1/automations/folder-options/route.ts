import { DataAccessError, folderTriggerOptions } from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return Response.json(await folderTriggerOptions(context, workspaceId), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
