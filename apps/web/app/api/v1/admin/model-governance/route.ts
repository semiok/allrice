import {
  DataAccessError,
  getModelGovernanceForAdmin,
  updateOrganizationModelQuota,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({
      governance: await getModelGovernanceForAdmin(context),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({
      quota: await updateOrganizationModelQuota({
        context,
        update: await request.json(),
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
