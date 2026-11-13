import {
  DataAccessError,
  setPersonalEmployeeMemoryPin,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { storageErrorResponse } from '../../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const memory = await setPersonalEmployeeMemoryPin(
      context,
      new URL(request.url).searchParams.get('workspaceId') ?? '',
      (await route.params).id,
      await request.json(),
    );
    return Response.json(
      { memory },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
