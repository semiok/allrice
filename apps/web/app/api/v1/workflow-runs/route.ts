import {
  DataAccessError,
  listWorkflowRuns,
  startWorkflowRun,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../lib/execution/responses';
import { getRequestContext } from '../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get('workspaceId');
    if (!workspaceId) throw new Error('workspaceId is required');
    return Response.json({
      workflowRuns: await listWorkflowRuns(context, {
        workspaceId,
        employeeId: url.searchParams.get('employeeId') ?? undefined,
        sessionId: url.searchParams.get('sessionId') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 20),
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workflowRun = await startWorkflowRun(context, await request.json());
    return Response.json(
      { workflowRun },
      {
        status: 201,
        headers: { location: `/api/v1/workflow-runs/${workflowRun.runId}` },
      },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
