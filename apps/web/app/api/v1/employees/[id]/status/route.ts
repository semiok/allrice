import { DataAccessError, updateEmployeeStatus } from '@allrice/database';

import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    await updateEmployeeStatus(context, id, await request.json());
    return Response.json({ updated: true });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
