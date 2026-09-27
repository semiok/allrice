import {
  DataAccessError,
  IdentityError,
  OrganizationAdministrationError,
  listManagedOrganizations,
  getManagedOrganization,
  createManagedOrganization,
  updateManagedOrganization,
  listOrganizationPeople,
  importOrganizationPeople,
  updateOrganizationPerson,
  setOrganizationAccountStatus,
  resetOrganizationPassword,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { readAdminJson } from '../tenant-administration/http';
import { isRequestValidationError } from '../api-error-response';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
export async function organizationAdministrationHttp(
  request: Request,
  organizationId?: string,
  userId?: string,
  action?: 'people' | 'status' | 'password',
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const url = new URL(request.url);
    if (request.method === 'GET') {
      const after = url.searchParams.get('after') ?? undefined;
      return Response.json(
        organizationId && action !== 'people'
          ? await getManagedOrganization(context, organizationId)
          : organizationId
            ? await listOrganizationPeople(context, organizationId, {
                after,
                search: url.searchParams.get('search') ?? undefined,
              })
            : await listManagedOrganizations(context, after),
        { headers },
      );
    }
    if (!sameOriginBrowserWrite(request))
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    const input = await readAdminJson(
      request,
      action === 'people' ? 1_048_576 : 32_768,
    );
    const result = !organizationId
      ? await createManagedOrganization(context, input)
      : !userId
        ? action === 'people'
          ? await importOrganizationPeople(context, organizationId, input)
          : await updateManagedOrganization(context, organizationId, input)
        : action === 'password'
          ? await resetOrganizationPassword(
              context,
              organizationId,
              userId,
              input,
            )
          : action === 'status'
            ? await setOrganizationAccountStatus(
                context,
                organizationId,
                userId,
                input,
              )
            : await updateOrganizationPerson(
                context,
                organizationId,
                userId,
                input,
              );
    return Response.json(result, {
      headers,
      status: !organizationId || action === 'people' ? 201 : 200,
    });
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
    } else if (error instanceof OrganizationAdministrationError) {
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
