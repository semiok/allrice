import {
  DataAccessError,
  promoteManagedEmployeeMemory,
} from '@allrice/database';

import { EmployeeMemoryWriteResponseSchema } from '@allrice/contracts';
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
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const { counts, ...memory } = await promoteManagedEmployeeMemory(
      context,
      workspaceId,
      id,
      await request.json(),
    );
    return Response.json(
      EmployeeMemoryWriteResponseSchema.parse({
        schemaVersion: 2,
        memory,
        counts,
      }),
      {
        headers: { 'cache-control': 'private, no-store' },
      },
    );
  } catch (error) {
    return storageErrorResponse(error);
  }
}
