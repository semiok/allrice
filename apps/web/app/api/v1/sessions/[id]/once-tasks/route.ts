import {
  createOnceTask,
  listOnceTasks,
  DataAccessError,
} from '@allrice/database';
import { OnceTaskListQuerySchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { onceErrorResponse } from './responses';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const search = new URL(request.url).searchParams;
    for (const key of search.keys()) {
      if (search.getAll(key).length !== 1)
        throw new SyntaxError('Duplicate once task query');
    }
    const query = OnceTaskListQuerySchema.parse(Object.fromEntries(search));
    return Response.json(
      await listOnceTasks(context, (await params).id, query),
    );
  } catch (error) {
    return onceErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const task = await createOnceTask(
      context,
      (await params).id,
      await request.json(),
    );
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    return onceErrorResponse(error);
  }
}
