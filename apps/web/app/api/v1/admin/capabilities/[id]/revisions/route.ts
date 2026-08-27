import {
  CapabilityRegistryError,
  DataAccessError,
  publishKnowledgeRevision,
  publishWorkflowRevision,
  updateCapabilityRevisionStatus,
} from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await route.params;
    const body = (await request.json()) as Record<string, unknown>;
    const { kind, ...input } = body;
    if (kind === 'workflow') {
      return Response.json(
        { revision: await publishWorkflowRevision(context, id, input) },
        { status: 201 },
      );
    }
    if (kind === 'knowledge') {
      return Response.json(
        { revision: await publishKnowledgeRevision(context, id, input) },
        { status: 201 },
      );
    }
    throw new CapabilityRegistryError('invalid_binding');
  } catch (error) {
    return capabilityErrorResponse(error);
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
      revision: await updateCapabilityRevisionStatus(
        context,
        id,
        await request.json(),
      ),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
