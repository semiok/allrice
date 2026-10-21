import { DataAccessError, listAutomationCatalog } from '@allrice/database';
import { getRequestContext } from '../../../../lib/identity/session';
import {
  recurringErrorResponse,
  taskQuery,
} from '../sessions/[id]/schedule-tasks/responses';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      await listAutomationCatalog(context, taskQuery(request)),
    );
  } catch (error) {
    return recurringErrorResponse(error);
  }
}
