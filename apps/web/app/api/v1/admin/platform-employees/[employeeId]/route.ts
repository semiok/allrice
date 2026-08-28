import {
  getPlatformEmployee,
  savePlatformEmployeeDraft,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ employeeId: string }>;
}

export async function GET(request: Request, routeContext: RouteContext) {
  try {
    await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    const employee = await getPlatformEmployee(employeeId);
    return employee
      ? Response.json({ employee })
      : Response.json({ error: { message: 'AI 员工不存在' } }, { status: 404 });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PUT(request: Request, routeContext: RouteContext) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    return Response.json({
      employee: await savePlatformEmployeeDraft(
        employeeId,
        await request.json(),
        context.actor.type === 'user' ? context.actor.id : 'platform-admin',
      ),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
