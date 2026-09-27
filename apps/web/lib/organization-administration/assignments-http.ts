import {
  DataAccessError,
  IdentityError,
  TenantEmployeeError,
  listOrganizationAiAssignments,
  changeOrganizationAiAssignments,
} from '@allrice/database';
import { OrganizationAiTargetSchema } from '@allrice/contracts';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { readAdminJson } from '../tenant-administration/http';
import { isRequestValidationError } from '../api-error-response';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function organizationAssignmentsHttp(
  request: Request,
  organizationId: string,
) {
  try {
    const context = await requirePlatformAdminContext(request),
      url = new URL(request.url);
    if (request.method === 'GET') {
      const raw = url.searchParams.get('target');
      if (raw && raw.length > 50_000) throw new SyntaxError();
      const target = OrganizationAiTargetSchema.parse(
        raw ? JSON.parse(raw) : { type: 'all' },
      );
      return Response.json(
        await listOrganizationAiAssignments(
          context,
          organizationId,
          url.searchParams.get('workspaceId') ?? '',
          target,
        ),
        { headers },
      );
    }
    if (!sameOriginBrowserWrite(request))
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    return Response.json(
      await changeOrganizationAiAssignments(
        context,
        organizationId,
        await readAdminJson(request, 65_536),
      ),
      { headers },
    );
  } catch (error) {
    let status = 503,
      code = 'ORGANIZATION_UNAVAILABLE';
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
