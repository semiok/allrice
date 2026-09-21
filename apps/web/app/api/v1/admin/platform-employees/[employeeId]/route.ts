import { getPlatformEmployee } from '@allrice/database';

import { apiProblem } from '../../../../../../lib/api-error-response';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { employeeAdministrationHttp } from '../../../../../../lib/tenant-administration/employee-http';

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
  return employeeAdministrationHttp(
    request,
    (await routeContext.params).employeeId,
    'save',
  );
}
