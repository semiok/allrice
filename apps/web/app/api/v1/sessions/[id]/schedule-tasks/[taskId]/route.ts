import {
  getRecurringTask,
  changeRecurringTask,
  DataAccessError,
} from '@allrice/database';
import { RecurringTaskDetailQuerySchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { recurringErrorResponse, taskQuery } from '../responses';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ id: string; taskId: string }> };
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id, taskId } = await params;
    return Response.json(
      await getRecurringTask(
        context,
        id,
        taskId,
        RecurringTaskDetailQuerySchema.parse(taskQuery(request)),
      ),
    );
  } catch (error) {
    return recurringErrorResponse(error);
  }
}
export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id, taskId } = await params;
    const operation = await changeRecurringTask(
      context,
      id,
      taskId,
      await request.json(),
    );
    return Response.json(
      { operation },
      { status: operation.status === 'rejected' ? 409 : 200 },
    );
  } catch (error) {
    return recurringErrorResponse(error);
  }
}
