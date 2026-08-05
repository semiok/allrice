import { DataAccessError, assignEmployeeVersion } from '@allrice/database';

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
    return Response.json({
      version: await assignEmployeeVersion(context, id, await request.json()),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
