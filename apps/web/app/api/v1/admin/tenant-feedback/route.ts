import { listTenantFeedback } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      await listTenantFeedback(
        context,
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
