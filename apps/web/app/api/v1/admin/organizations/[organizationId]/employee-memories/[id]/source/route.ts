import { createEmployeeMemoryPort } from '@allrice/database';
import {
  MemoryAdminDetailQueryProjectionSchema,
  MemorySourceViewProjectionSchema,
} from '@allrice/contracts';
import { requirePlatformAdminContext } from '../../../../../../../../../lib/identity/platform-admin';
import { storageErrorResponse } from '../../../../../../../../../lib/storage/responses';

export const runtime = 'nodejs';
const memory = createEmployeeMemoryPort();
const querySchema = MemoryAdminDetailQueryProjectionSchema.omit({
  organizationId: true,
  memoryId: true,
});

/** Thin read adapter for the real administrator's independently audited scope.
 * No personal selector or module qualification is accepted from HTTP input. */
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string; id: string }> },
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { organizationId, id } = await route.params;
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const input = MemoryAdminDetailQueryProjectionSchema.parse({
      organizationId,
      memoryId: id,
      ...query,
    });
    const result = await memory.source(context, input, request.signal);
    return Response.json(MemorySourceViewProjectionSchema.parse(result), {
      headers: { 'cache-control': 'private, no-store' },
    });
  } catch (error) {
    const response = storageErrorResponse(error);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  }
}
