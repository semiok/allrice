import { listImageOperations } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      { operations: await listImageOperations(context) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
