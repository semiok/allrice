import {
  DataAccessError,
  getChatSessionHistory,
  updateChatSession,
} from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';

export const runtime = 'nodejs';

function workspaceId(request: Request) {
  const id = new URL(request.url).searchParams.get('workspaceId');
  if (!id) throw new DataAccessError('not_found');
  return id;
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      history: await getChatSessionHistory(context, workspaceId(request), id),
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    const session = await updateChatSession(
      context,
      workspaceId(request),
      id,
      await request.json(),
    );
    return Response.json({ session });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
