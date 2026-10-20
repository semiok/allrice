import { cancelOnceTask, DataAccessError } from '@allrice/database';
import { getRequestContext } from '../../../../../../../../lib/identity/session';
import { onceErrorResponse } from '../../responses';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id, taskId } = await params;
    return Response.json({ task: await cancelOnceTask(context, id, taskId) });
  } catch (error) {
    return onceErrorResponse(error);
  }
}
