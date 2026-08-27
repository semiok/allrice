import { DataAccessError, decideConnectorApproval } from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../lib/capabilities/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await params;
    return Response.json({
      approval: await decideConnectorApproval(
        context,
        id,
        await request.json(),
      ),
    });
  } catch (error) {
    return capabilityErrorResponse(error);
  }
}
