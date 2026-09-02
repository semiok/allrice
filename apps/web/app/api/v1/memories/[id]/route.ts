import {
  DataAccessError,
  correctWorkspaceMemory,
  deleteWorkspaceMemory,
} from '@allrice/database';

import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const memory = await correctWorkspaceMemory(
      context,
      workspaceId,
      id,
      await request.json(),
    );
    return Response.json({
      memory: {
        ...memory,
        ownedByMe:
          context.actor.type === 'user' && memory.ownerId === context.actor.id,
      },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    await deleteWorkspaceMemory(context, workspaceId, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
