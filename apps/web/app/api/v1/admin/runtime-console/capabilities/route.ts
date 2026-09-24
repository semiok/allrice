import { readRuntimeCapabilityResponse } from '../../../../../../lib/runtime-capabilities';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
    return Response.json(await readRuntimeCapabilityResponse(), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
