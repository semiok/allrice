import {
  DataAccessError,
  getAutomationCatalogTask,
  changeAutomationCatalogTask,
  getAutomationCatalogOperation,
  NativeOnceProductError,
} from '@allrice/database';
import { UuidSchema, RecurringTaskDetailQuerySchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../lib/identity/session';
import {
  recurringErrorResponse,
  taskQuery,
} from '../../sessions/[id]/schedule-tasks/responses';
import { onceErrorResponse } from '../../sessions/[id]/once-tasks/responses';
type RouteContext = { params: Promise<{ taskId: string }> };
export const runtime = 'nodejs';
function query(request: Request) {
  const { workspaceId, ...detail } = taskQuery(request);
  return { workspaceId: UuidSchema.parse(workspaceId), detail };
}
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { workspaceId, detail } = query(request);
    const parsed = RecurringTaskDetailQuerySchema.parse(detail);
    return Response.json(
      parsed.operationId
        ? await getAutomationCatalogOperation(
            context,
            workspaceId,
            (await params).taskId,
            parsed.operationId,
          )
        : await getAutomationCatalogTask(
            context,
            workspaceId,
            (await params).taskId,
            parsed,
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
    const { workspaceId, detail } = query(request);
    if (Object.keys(detail).length) throw new SyntaxError('Unexpected query');
    const result = await changeAutomationCatalogTask(
      context,
      workspaceId,
      (await params).taskId,
      await request.json(),
    );
    return Response.json(result, {
      status:
        'operation' in result && result.operation?.status === 'rejected'
          ? 409
          : 200,
    });
  } catch (error) {
    return error instanceof NativeOnceProductError
      ? onceErrorResponse(error)
      : recurringErrorResponse(error);
  }
}
