import {
  DataAccessError,
  IdentityError,
  TenantEmployeeError,
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { isRequestValidationError } from '../api-error-response';
import { readAdminJson } from './http';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function tenantEmployeesHttp(
  request: Request,
  organizationId: string,
) {
  try {
    const context = await requirePlatformAdminContext(request);
    if (request.method === 'GET')
      return Response.json(
        await listAdminTenantEmployees(
          context,
          organizationId,
          new URL(request.url).searchParams.get('workspaceId') ?? '',
        ),
        { headers },
      );
    if (!sameOriginBrowserWrite(request))
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    return Response.json(
      await changeAdminTenantEmployee(
        context,
        organizationId,
        await readAdminJson(request),
      ),
      { headers },
    );
  } catch (error) {
    let status = 503,
      code = 'TENANT_EMPLOYEE_UNAVAILABLE';
    if (error instanceof DataAccessError) {
      status =
        error.code === 'authentication_required'
          ? 401
          : error.code === 'not_found'
            ? 404
            : 403;
      code =
        status === 401
          ? 'AUTHENTICATION_REQUIRED'
          : status === 404
            ? 'NOT_FOUND'
            : 'AUTHORIZATION_DENIED';
    } else if (error instanceof IdentityError) {
      status = 403;
      code = 'AUTHORIZATION_DENIED';
    } else if (error instanceof TenantEmployeeError) {
      status = 409;
      code = error.code;
    } else if (
      error instanceof SyntaxError ||
      isRequestValidationError(error)
    ) {
      status = 400;
      code = 'INVALID_REQUEST';
    }
    return Response.json({ code }, { status, headers });
  }
}
