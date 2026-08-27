import { DataAccessError, listModelPool } from '@allrice/database';

import { executionErrorResponse } from '../../../../lib/execution/responses';
import { getRequestContext } from '../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({ modelPool: await listModelPool(context) });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
