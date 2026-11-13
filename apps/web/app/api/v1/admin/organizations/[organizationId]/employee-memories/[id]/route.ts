import { getAdminEmployeeMemory } from '@allrice/database';
import {
  EmployeeMemoryDetailResponseSchema,
  UuidSchema,
} from '@allrice/contracts';
import { z } from 'zod';
import { requirePlatformAdminContext } from '../../../../../../../../lib/identity/platform-admin';
import { storageErrorResponse } from '../../../../../../../../lib/storage/responses';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string; id: string }> },
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { organizationId, id } = await route.params;
    const query = z
      .object({ ownerId: UuidSchema, instanceId: UuidSchema })
      .strict()
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    const result = await getAdminEmployeeMemory(
      context,
      organizationId,
      query.ownerId,
      query.instanceId,
      id,
    );
    return Response.json(EmployeeMemoryDetailResponseSchema.parse(result), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
