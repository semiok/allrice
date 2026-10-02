import {
  listOrganizationActivityOverview,
  listOrganizationActivityPeople,
  listOrganizationActivityRuns,
  readOrganizationDashboard,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../identity/platform-admin';
import { executionErrorResponse } from '../execution/responses';
export async function organizationActivityHttp(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request),
      p = new URL(request.url).searchParams,
      org = p.get('organizationId'),
      user = p.get('userId');
    const filter = {
      range: p.get('range') ?? '7d',
      from: p.get('from') ?? undefined,
      to: p.get('to') ?? undefined,
      timeZone: p.get('timeZone') ?? undefined,
      userId: user ?? undefined,
      employeeId: p.get('employeeId') ?? undefined,
      jobTitle: p.get('jobTitle') ?? undefined,
    };
    const result =
      org && p.get('view') === 'dashboard'
        ? await readOrganizationDashboard(context, org, filter)
        : org && p.get('view') === 'companyRuns'
          ? await listOrganizationActivityRuns(context, org, user, {
              ...filter,
              measure: p.get('measure') ?? 'activity',
              status: p.get('status') ?? 'all',
              before: p.get('before') ?? undefined,
            })
          : !org
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
