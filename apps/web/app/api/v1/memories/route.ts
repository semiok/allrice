import {
  DataAccessError,
  createTraceableMemory,
  createManagedEmployeeMemory,
  listWorkspaceMemories,
} from '@allrice/database';
import {
  EmployeeMemoryTextSchema,
  EmployeeMemoryWriteResponseSchema,
} from '@allrice/contracts';

import { getRequestContext } from '../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../lib/identity/request-origin';
import { storageErrorResponse } from '../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const employeeId = new URL(request.url).searchParams.get('employeeId');
    const query = new URL(request.url).searchParams;
    const memories = await listWorkspaceMemories(
      context,
      workspaceId,
      employeeId ?? undefined,
      {
        personal: query.get('personal') === '1',
        sourceId: query.get('sourceId') ?? undefined,
        runId: query.get('runId') ?? undefined,
        instanceId: query.get('instanceId') ?? undefined,
      },
    );
    return Response.json(
      {
        memories: memories.map((memory) => ({
          ...memory,
          ownedByMe:
            context.actor.type === 'user' &&
            memory.ownerId === context.actor.id,
        })),
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = await request.json();
    // Explicit legacy creation compatibility; its full content is never inferred
    // from a v2 summary. New management requests use the complete pair contract.
    if (input && typeof input === 'object' && 'content' in input) {
      if (input.sourceType !== 'user')
        throw new DataAccessError('authorization_denied');
      EmployeeMemoryTextSchema.parse(input.content);
      const memory = await createTraceableMemory(context, input);
      return Response.json(
        { memory: { ...memory, ownedByMe: true } },
        { status: 201, headers: { 'cache-control': 'private, no-store' } },
      );
    }
    const { counts, ...memory } = await createManagedEmployeeMemory(
      context,
      input,
    );
    return Response.json(
      EmployeeMemoryWriteResponseSchema.parse({
        schemaVersion: 2,
        memory,
        counts,
      }),
      {
        status: 201,
        headers: { 'cache-control': 'private, no-store' },
      },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
