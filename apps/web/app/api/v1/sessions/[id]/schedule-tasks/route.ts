import {
  createRecurringTask,
  listRecurringTasks,
  DataAccessError,
} from '@allrice/database';
import { RecurringTaskListQuerySchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { recurringErrorResponse, taskQuery } from './responses';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = RecurringTaskListQuerySchema.parse(taskQuery(request));
    return Response.json(
      await listRecurringTasks(context, (await params).id, query),
    );
  } catch (error) {
    return recurringErrorResponse(error);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      {
        task: await createRecurringTask(
          context,
          (await params).id,
          await request.json(),
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return recurringErrorResponse(error);
  }
}
