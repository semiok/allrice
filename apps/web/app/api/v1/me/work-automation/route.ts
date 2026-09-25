import {
  getWorkAutomation,
  updateWorkAutomation,
  WorkAutomationConflict,
  DataAccessError,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { apiProblem } from '../../../../../lib/api-error-response';
import { readAdminJson } from '../../../../../lib/tenant-administration/http';

export const runtime = 'nodejs';
async function respond(request: Request, update: boolean) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    if (update && !sameOriginBrowserWrite(request))
      return apiProblem({
        status: 403,
        code: 'AUTHORIZATION_DENIED',
        message: '请从当前工作台修改设置。',
      });
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId)
      return apiProblem({
        status: 400,
        code: 'VALIDATION_FAILED',
        message: '请选择工作区。',
      });
    const value = update
      ? await updateWorkAutomation(
          context,
          workspaceId,
          await readAdminJson(request, 2048),
        )
      : await getWorkAutomation(context, workspaceId);
    return Response.json(value, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof WorkAutomationConflict)
      return apiProblem({
        status: 409,
        code: 'CONFLICT',
        message: error.message,
      });
    return executionErrorResponse(error);
  }
}
export const GET = (request: Request) => respond(request, false);
export const PATCH = (request: Request) => respond(request, true);
