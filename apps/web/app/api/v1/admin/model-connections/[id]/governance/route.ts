import {
  DataAccessError,
  getProviderGovernance,
  isPlatformAdmin,
  updateProviderGovernance,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    if (!(await isPlatformAdmin(context))) {
      throw new DataAccessError('authorization_denied');
    }
    const { id } = await route.params;
    return Response.json({ provider: await getProviderGovernance(id) });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    return Response.json({
      provider: await updateProviderGovernance({
        context,
        connectionId: id,
        update: await request.json(),
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
