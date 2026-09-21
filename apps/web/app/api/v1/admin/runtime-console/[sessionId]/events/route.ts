import { listDshRuntimeEventTimeline } from '@allrice/database';

import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ sessionId: string }> },
) {
  try {
    await requirePlatformAdminContext(request);
    const { sessionId } = await route.params;
    return Response.json({
      timeline: await listDshRuntimeEventTimeline(sessionId),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
