import {
  DataAccessError,
  cancelRun,
  getRun,
  requestManagedBrowserTaskCancel,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const cancellation = await request.json().catch(() => ({}));
    const task = await requestManagedBrowserTaskCancel(
      context,
      workspaceId,
      id,
    );

    const currentRun = await getRun(context, workspaceId, task.runId);
    if (
      ['succeeded', 'failed'].includes(task.status) ||
      ['succeeded', 'failed', 'dead_letter', 'canceled'].includes(
        currentRun.job.status,
      )
    ) {
      return Response.json(
        { task, run: currentRun },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }

    const run = await cancelRun(context, workspaceId, task.runId, cancellation);
    return Response.json(
      { task, run },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
