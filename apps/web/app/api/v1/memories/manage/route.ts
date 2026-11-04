import {
  DataAccessError,
  listPersonalEmployeeMemories,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = new URL(request.url).searchParams;
    const result = await listPersonalEmployeeMemories(
      context,
      query.get('workspaceId') ?? '',
      query.get('instanceId') ?? '',
      {
        state: query.get('state') ?? undefined,
        after: query.get('after') ?? undefined,
      },
    );
    return Response.json(result, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
