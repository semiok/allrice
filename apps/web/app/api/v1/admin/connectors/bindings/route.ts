import {
  DataAccessError,
  createConnectorBinding,
  updateConnectorBindingHealth,
} from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { binding: await createConnectorBinding(context, await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({
      binding: await updateConnectorBindingHealth(
        context,
        await request.json(),
      ),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
