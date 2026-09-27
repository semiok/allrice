import {
  listOrganizationActivityOverview,
  listOrganizationActivityPeople,
  listOrganizationActivityRuns,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { executionErrorResponse } from '../execution/responses';
export async function organizationActivityHttp(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request),
      p = new URL(request.url).searchParams,
      org = p.get('organizationId'),
      user = p.get('userId');
    const result = !org
      ? await listOrganizationActivityOverview(
          context,
          p.get('after') ?? undefined,
        )
      : !user
        ? await listOrganizationActivityPeople(context, org, {
            after: p.get('after') ?? undefined,
            search: p.get('search') ?? undefined,
          })
        : await listOrganizationActivityRuns(context, org, user, {
            employeeId: p.get('employeeId') ?? undefined,
            status: p.get('status') ?? 'all',
            before: p.get('before') ?? undefined,
          });
    return Response.json(result, {
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    return executionErrorResponse(e);
  }
}
