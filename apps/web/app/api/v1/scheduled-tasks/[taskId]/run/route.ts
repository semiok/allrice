import { UuidSchema, ManualAutomationRunInputSchema } from '@allrice/contracts';
import {
  DataAccessError,
  runManualAutomation,
  getManualAutomationRun,
  ManualAutomationRunError,
} from '@allrice/database';
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
      throw new SyntaxError('Unexpected manual query');
    const taskId = UuidSchema.parse((await params).taskId),
      input = ManualAutomationRunInputSchema.parse(await request.json());
    try {
      return Response.json(
        await runManualAutomation(
          context,
          UuidSchema.parse(workspaceId),
          taskId,
          input,
        ),
        { status: 202 },
      );
    } catch (error) {
      if (
        error instanceof ManualAutomationRunError &&
        error.code !== 'binding_conflict'
      ) {
        const messages = {
          request_conflict: '该请求已有不同内容，请读取原请求。',
          revision_conflict: '任务已被修改。本次未执行，请刷新后再决定。',
          unavailable: '任务已删除、取消或暂不支持立即执行。本次未执行。',
          authority_denied: '当前无权立即执行该任务，本次未执行。',
          content_limit:
            '任务正文与立即执行说明超过单条消息上限，本次未执行；原正文和计划已保留。',
        };
        return Response.json(
          {
            source: 'manual',
            status: 'rejected',
            taskId,
            request: input,
            code: error.code,
            message: messages[error.code],
          },
          { status: error.code === 'authority_denied' ? 403 : 409 },
        );
      }
      throw error;
    }
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { workspaceId, requestId, runId, ...extra } = taskQuery(request);
    if (Object.keys(extra).length)
      throw new SyntaxError('Unexpected manual query');
    return Response.json(
      await getManualAutomationRun(
        context,
        UuidSchema.parse(workspaceId),
        UuidSchema.parse((await params).taskId),
        UuidSchema.parse(requestId),
        runId ? UuidSchema.parse(runId) : undefined,
      ),
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
