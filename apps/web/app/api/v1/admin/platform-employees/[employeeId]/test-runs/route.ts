import {
  listPlatformEmployeeTestRuns,
  queuePlatformEmployeeTestRun,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ employeeId: string }>;
}

export async function GET(request: Request, routeContext: RouteContext) {
  try {
    await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    return Response.json({
      testRuns: await listPlatformEmployeeTestRuns(employeeId),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function POST(request: Request, routeContext: RouteContext) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    return Response.json(
      await queuePlatformEmployeeTestRun(
        employeeId,
        await request.json(),
        context.actor.id,
      ),
      { status: 202 },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
