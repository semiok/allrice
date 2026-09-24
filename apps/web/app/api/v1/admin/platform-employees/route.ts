import { tenantTrialPortal } from '../../../../../lib/portal/config';
import { rapidEmployeeIterationEnabled } from '@allrice/contracts';
import {
  createPlatformEmployeeDraft,
  listPlatformEmployees,
  listPlatformEmployeeWorkspaces,
  listPlatformNativeSkills,
  listEmployeeToolAvailability,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
    const [employees, skills, workspaces] = await Promise.all([
      listPlatformEmployees(),
      listPlatformNativeSkills(),
      listPlatformEmployeeWorkspaces(),
    ]);
    const origin = new URL(request.url);
    origin.host = request.headers.get('host') ?? origin.host;
    return Response.json(
      {
        employees,
        skills,
        workspaces: workspaces.map((workspace) => ({
          ...workspace,
          trialUrl: tenantTrialPortal(
            workspace.organizationSlug,
            origin.toString(),
          ),
        })),
        tools: listEmployeeToolAvailability(),
        rapidIteration: rapidEmployeeIterationEnabled(),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      {
        employee: await createPlatformEmployeeDraft(
          await request.json(),
          context.actor.id,
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
