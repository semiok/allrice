import { compilePlatformEmployee } from '@allrice/database';

import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ employeeId: string }>;
}

export async function POST(request: Request, routeContext: RouteContext) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    return Response.json(
      await compilePlatformEmployee(
        employeeId,
        context.actor.type === 'user' ? context.actor.id : 'platform-admin',
      ),
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
