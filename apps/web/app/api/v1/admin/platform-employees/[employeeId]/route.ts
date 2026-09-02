import {
  compilePlatformEmployee,
  getPlatformEmployee,
  savePlatformEmployeeDraft,
} from '@allrice/database';

import { apiProblem } from '../../../../../../lib/api-error-response';
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
      : apiProblem({
          status: 404,
          code: 'RESOURCE_NOT_FOUND',
          message: 'AI 员工不存在',
        });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PUT(request: Request, routeContext: RouteContext) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    const actorLabel =
      context.actor.type === 'user' ? context.actor.id : 'platform-admin';
    await savePlatformEmployeeDraft(
      employeeId,
      await request.json(),
      actorLabel,
    );
    const validation = await compilePlatformEmployee(employeeId, actorLabel);
    return Response.json({
      employee: await getPlatformEmployee(employeeId),
      validation,
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
