import {
  DataAccessError,
  createChatSession,
  listChatSessions,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = new URL(request.url).searchParams;
    const workspaceId = query.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return Response.json(
      await listChatSessions(context, workspaceId, {
        cursor: query.get('cursor') ?? undefined,
        includeArchived: query.get('archived') === 'true',
      }),
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const session = await createChatSession(context, await request.json());
    return Response.json({ session }, { status: 201 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
