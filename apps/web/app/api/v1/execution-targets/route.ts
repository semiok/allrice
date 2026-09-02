import {
  DataAccessError,
  listExecutionTargets,
  registerExecutionTarget,
} from '@allrice/database';

import { capabilityErrorResponse } from '../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    return Response.json({
      targets: await listExecutionTargets(context, workspaceId),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { target: await registerExecutionTarget(context, await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
