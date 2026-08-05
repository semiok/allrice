import { DataAccessError, enqueueRun } from '@allrice/database';

import { executionErrorResponse } from '../../../../lib/execution/responses';
import { getRequestContext } from '../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const result = await enqueueRun(context, await request.json());
    return Response.json(
      { run: result.run, idempotentReplay: !result.created },
      {
        status: result.created ? 201 : 200,
        headers: { location: `/api/v1/runs/${result.run.id}` },
      },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
