import {
  DataAccessError,
  createTraceableMemory,
  listWorkspaceMemories,
} from '@allrice/database';

import { getRequestContext } from '../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const employeeId = new URL(request.url).searchParams.get('employeeId');
    const memories = await listWorkspaceMemories(
      context,
      workspaceId,
      employeeId ?? undefined,
    );
    return Response.json({
      memories: memories.map((memory) => ({
        ...memory,
        ownedByMe:
          context.actor.type === 'user' && memory.ownerId === context.actor.id,
      })),
    });
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const memory = await createTraceableMemory(context, await request.json());
    return Response.json(
      {
        memory: {
          ...memory,
          ownedByMe:
            context.actor.type === 'user' &&
            memory.ownerId === context.actor.id,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
