import {
  archivePlatformEmployee,
  disablePlatformEmployee,
  listPlatformEmployeeAuditEvents,
  rollbackPlatformEmployee,
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
      auditEvents: await listPlatformEmployeeAuditEvents(employeeId),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function POST(request: Request, routeContext: RouteContext) {
  try {
    const context = await requirePlatformAdminContext(request);
    const { employeeId } = await routeContext.params;
    const body = (await request.json()) as {
      action?: unknown;
      reason?: unknown;
    };
    if (body.action === 'disable') {
      return Response.json(
        await disablePlatformEmployee(
          employeeId,
          { reason: body.reason },
          context.actor.id,
        ),
      );
    }
    if (body.action === 'rollback') {
      return Response.json(
        await rollbackPlatformEmployee(
          employeeId,
          { reason: body.reason },
          context.actor.id,
        ),
      );
    }
    if (body.action === 'archive') {
      return Response.json(
        await archivePlatformEmployee(
          employeeId,
          { reason: body.reason },
          context.actor.id,
        ),
      );
    }
    return Response.json(
      { error: { message: '不支持的员工生命周期动作' } },
      { status: 400 },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
