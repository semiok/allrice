import {
  DataAccessError,
  createModelConnection,
  listModelPool,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

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

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      {
        connection: await createModelConnection(context, await request.json()),
      },
      { status: 201 },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
