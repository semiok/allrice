import {
  DataAccessError,
  correctWorkspaceMemory,
  correctManagedEmployeeMemory,
  deleteManagedEmployeeMemory,
  getPersonalEmployeeMemory,
} from '@allrice/database';
import {
  EmployeeMemoryTextSchema,
  EmployeeMemoryListQuerySchema,
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryWriteResponseSchema,
} from '@allrice/contracts';

import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { storageErrorResponse } from '../../../../../lib/storage/responses';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = EmployeeMemoryListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(
      EmployeeMemoryDetailResponseSchema.parse(
        await getPersonalEmployeeMemory(
          context,
          query.workspaceId,
          query.instanceId,
          (await route.params).id,
        ),
      ),
      {
        headers: { 'cache-control': 'private, no-store' },
      },
    );
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}

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
    if (input && typeof input === 'object' && 'content' in input) {
      EmployeeMemoryTextSchema.parse(input.content);
      const memory = await correctWorkspaceMemory(
        context,
        workspaceId,
        id,
        input,
      );
      return Response.json(
        { memory: { ...memory, ownedByMe: true } },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    }
    const { counts, ...memory } = await correctManagedEmployeeMemory(
      context,
      workspaceId,
      id,
      input,
    );
    return Response.json(
      EmployeeMemoryWriteResponseSchema.parse({
        schemaVersion: 2,
        memory,
        counts,
      }),
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
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
    await deleteManagedEmployeeMemory(
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
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
