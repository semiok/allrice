import {
  DataAccessError,
  listPersonalEmployeeMemories,
} from '@allrice/database';
import { EmployeeMemoryListQuerySchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../lib/identity/session';
import { storageErrorResponse } from '../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = EmployeeMemoryListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const result = await listPersonalEmployeeMemories(
      context,
      query.workspaceId,
      query.instanceId,
    );
    return Response.json(result, {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
