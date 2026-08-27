import {
  DataAccessError,
  getEmployeeModelPolicy,
  upsertEmployeeModelPolicy,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function workspaceId(request: Request, contextWorkspaceId: string | null) {
  const selected =
    new URL(request.url).searchParams.get('workspaceId') ?? contextWorkspaceId;
  if (!selected) throw new DataAccessError('not_found');
  return selected;
}

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      policy: await getEmployeeModelPolicy({
        context,
        workspaceId: workspaceId(request, context.workspaceId),
        employeeId: id,
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      policy: await upsertEmployeeModelPolicy({
        context,
        workspaceId: workspaceId(request, context.workspaceId),
        employeeId: id,
        policy: await request.json(),
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
