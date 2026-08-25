import { DataAccessError, manageEmployeeAssignments } from '@allrice/database';

import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function PUT(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    const input = await request.json();
    return Response.json({
      employeeHub: await manageEmployeeAssignments(context, {
        ...input,
        employeeId: id,
      }),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
