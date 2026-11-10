import { listAdminEmployeeMemories } from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { z } from 'zod';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { storageErrorResponse } from '../../../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string }> },
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { organizationId } = await route.params;
    const query = z
      .object({ ownerId: UuidSchema, instanceId: UuidSchema })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const result = await listAdminEmployeeMemories(
      context,
      organizationId,
      query.ownerId,
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
