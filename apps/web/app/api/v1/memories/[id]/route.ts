import {
  DataAccessError,
  EmployeeMemoryCapacityError,
  correctWorkspaceMemory,
  deleteWorkspaceMemory,
} from '@allrice/database';
import { EmployeeMemoryTextSchema } from '@allrice/contracts';

import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { storageErrorResponse } from '../../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const input = await request.json();
    EmployeeMemoryTextSchema.parse(input.content);
    const memory = await correctWorkspaceMemory(
      context,
      workspaceId,
      id,
      input,
    );
    return Response.json(
      {
        memory: {
          ...memory,
          ownedByMe:
            context.actor.type === 'user' &&
            memory.ownerId === context.actor.id,
        },
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof EmployeeMemoryCapacityError)
      return Response.json({ error: 'memory_capacity', remainingBytes: error.remainingBytes },
        { status: 422, headers: { 'cache-control': 'private, no-store' } });
    return storageErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const body = await request.text();
    await deleteWorkspaceMemory(
      context,
      workspaceId,
      id,
      body ? JSON.parse(body) : undefined,
    );
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}
