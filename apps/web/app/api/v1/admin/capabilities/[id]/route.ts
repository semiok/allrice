import { DataAccessError, updateCapabilityStatus } from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../../lib/capabilities/responses';
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
      capability: await updateCapabilityStatus(
        context,
        id,
        await request.json(),
      ),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
