import {
  DataAccessError,
  IdentityError,
  TenantAdministrationError,
  listAdminTenants,
  listAdminTenantMembers,
  updateAdminTenantMember,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { isRequestValidationError } from '../api-error-response';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
async function readBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new SyntaxError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8000) {
        await reader.cancel();
        throw new SyntaxError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function tenantAdministrationHttp(
  request: Request,
  organizationId?: string,
  membershipId?: string,
) {
  try {
    const context = await requirePlatformAdminContext(request);
    const url = new URL(request.url);
    if (membershipId) {
      if (!sameOriginBrowserWrite(request))
        return Response.json(
          { code: 'ORIGIN_DENIED' },
          { status: 403, headers },
        );
      return Response.json(
        await updateAdminTenantMember(
          context,
          organizationId!,
          membershipId,
          await readBody(request),
        ),
        { headers },
      );
    }
    const cursor = url.searchParams.get('after') ?? undefined;
    return Response.json(
      organizationId
        ? await listAdminTenantMembers(
            context,
            organizationId,
            url.searchParams.get('workspaceId'),
            cursor,
          )
        : await listAdminTenants(context, cursor),
      { headers },
    );
  } catch (error) {
    let status = 503,
      code = 'TENANT_ADMIN_UNAVAILABLE';
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
    } else if (error instanceof TenantAdministrationError) {
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
