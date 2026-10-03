import { DataAccessError, listFolderTriggerHistory } from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return Response.json(
      await listFolderTriggerHistory(context, workspaceId, (await params).id),
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
