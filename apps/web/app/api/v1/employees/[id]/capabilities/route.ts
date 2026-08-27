import {
  CapabilityRegistryError,
  DataAccessError,
  listEmployeeCapabilities,
  manageEmployeeCapabilities,
} from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new CapabilityRegistryError('invalid_binding');
    const { id } = await route.params;
    return Response.json({
      capabilities: await listEmployeeCapabilities(context, workspaceId, id),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
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
    const input = (await request.json()) as Record<string, unknown>;
    return Response.json({
      capabilities: await manageEmployeeCapabilities(context, {
        ...input,
        employeeId: id,
      }),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
