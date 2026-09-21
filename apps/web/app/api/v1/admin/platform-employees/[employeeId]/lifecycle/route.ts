import {
  archivePlatformEmployee,
  disablePlatformEmployee,
  listPlatformEmployeeAuditEvents,
  rollbackPlatformEmployee,
} from '@allrice/database';
import { PlatformEmployeeLifecycleInputSchema } from '@allrice/contracts';

import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { readAdminJson } from '../../../../../../../lib/tenant-administration/http';
import { apiProblem } from '../../../../../../../lib/api-error-response';

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
    if (error instanceof SyntaxError)
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: '请求格式或大小不正确。',
      });
    return executionErrorResponse(error);
  }
}

export async function POST(request: Request, routeContext: RouteContext) {
  try {
    const context = await requirePlatformAdminContext(request);
    if (!sameOriginBrowserWrite(request))
      return apiProblem({
        status: 403,
        code: 'AUTHORIZATION_DENIED',
        message: '仅允许同源管理操作。',
      });
    const { employeeId } = await routeContext.params;
    const body = PlatformEmployeeLifecycleInputSchema.parse(
      await readAdminJson(request, 32000),
    );
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
      if (!body.expectedPublishedRevisionId || !body.expectedWorkspaceIds)
        return apiProblem({
          status: 409,
          code: 'CONFLICT',
          message: '请刷新并核对回退版本和全部受影响的工作区。',
          retryable: false,
        });
      return Response.json(
        await rollbackPlatformEmployee(
          employeeId,
          {
            reason: body.reason,
            revisionId: body.revisionId,
            expectedPublishedRevisionId: body.expectedPublishedRevisionId,
            expectedWorkspaceIds: body.expectedWorkspaceIds,
          },
          context.actor.id,
          context,
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
    return executionErrorResponse(
      new Error('Unsupported platform employee lifecycle action'),
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: '请求格式或大小不正确。',
      });
    return executionErrorResponse(error);
  }
}
