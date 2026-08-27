import { DataAccessError, updateModelConnection } from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const requestContext = await getRequestContext(request);
    if (!requestContext) throw new DataAccessError('authentication_required');
    const { id } = await context.params;
    return Response.json({
      connection: await updateModelConnection({
        context: requestContext,
        connectionId: id,
        update: await request.json(),
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
