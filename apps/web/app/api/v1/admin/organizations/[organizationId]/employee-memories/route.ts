import { listAdminEmployeeMemories } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { storageErrorResponse } from '../../../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(request: Request, route: { params: Promise<{ organizationId: string }> }) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { organizationId } = await route.params;
    const query = new URL(request.url).searchParams;
    const result = await listAdminEmployeeMemories(context, organizationId, query.get('ownerId') ?? '', query.get('instanceId') ?? '', {
      state: query.get('state') ?? undefined, after: query.get('after') ?? undefined,
    });
    return Response.json(result, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) { return storageErrorResponse(error); }
}
