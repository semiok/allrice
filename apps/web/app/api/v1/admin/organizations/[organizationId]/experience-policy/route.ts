import { readAdminJson } from '../../../../../../../lib/tenant-administration/http';
import {
  getExperiencePolicy,
  updateExperiencePolicy,
  ExperienceError,
} from '@allrice/database';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type Route = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, route: Route) {
  try {
    return Response.json(
      {
        policy: await getExperiencePolicy(
          await requirePlatformAdminContext(request),
          (await route.params).organizationId,
        ),
      },
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function PUT(request: Request, route: Route) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return new Response(null, { status: 415, headers });
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      {
        policy: await updateExperiencePolicy(
          context,
          (await route.params).organizationId,
          await readAdminJson(request, 8192),
        ),
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof ExperienceError && error.code === 'conflict')
      return Response.json({ code: 'conflict' }, { status: 409, headers });
    return executionErrorResponse(error);
  }
}
