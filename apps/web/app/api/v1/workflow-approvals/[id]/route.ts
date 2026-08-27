import { DataAccessError, decideWorkflowApproval } from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
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
      workflowRun: await decideWorkflowApproval(
        context,
        id,
        await request.json(),
      ),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
