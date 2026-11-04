import {
  CapabilityRegistryError,
  DataAccessError,
  createKnowledgeSource,
  listCapabilityCatalog,
} from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new CapabilityRegistryError('invalid_binding');
    return Response.json({
      catalog: await listCapabilityCatalog(context, workspaceId),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const body = (await request.json()) as Record<string, unknown>;
    const { kind, ...input } = body;
    if (kind === 'knowledge') {
      return Response.json(
        { revision: await createKnowledgeSource(context, input) },
        { status: 201 },
      );
    }
    throw new CapabilityRegistryError('invalid_binding');
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
