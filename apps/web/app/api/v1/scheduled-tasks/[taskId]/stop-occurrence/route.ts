import {
  DataAccessError,
  getAutomationCatalogOccurrenceRun,
  stopAutomationCatalogOccurrence,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { taskQuery } from '../../../sessions/[id]/schedule-tasks/responses';

type RouteContext = { params: Promise<{ taskId: string }> };
export const runtime = 'nodejs';

export async function POST(request: Request, { params }: RouteContext) {
  if (!sameOriginBrowserWrite(request))
    return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403 });
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { workspaceId, ...extra } = taskQuery(request);
    if (Object.keys(extra).length)
      throw new SyntaxError('Unexpected stop query');
    return Response.json(
      await stopAutomationCatalogOccurrence(
        context,
        UuidSchema.parse(workspaceId),
        UuidSchema.parse((await params).taskId),
        await request.json(),
      ),
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { workspaceId, occurrenceId, runId, ...extra } = taskQuery(request);
    if (Object.keys(extra).length)
      throw new SyntaxError('Unexpected stop query');
    return Response.json(
      await getAutomationCatalogOccurrenceRun(
        context,
        UuidSchema.parse(workspaceId),
        UuidSchema.parse((await params).taskId),
        {
          occurrenceId: UuidSchema.parse(occurrenceId),
          runId: UuidSchema.parse(runId),
        },
      ),
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
