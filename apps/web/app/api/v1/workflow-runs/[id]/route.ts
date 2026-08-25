import { DataAccessError, getWorkflowRun } from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new Error('workspaceId is required');
    const { id } = await params;
    return Response.json({
      workflowRun: await getWorkflowRun(context, workspaceId, id),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
