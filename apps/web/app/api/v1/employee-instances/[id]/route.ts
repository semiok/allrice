import {
  DataAccessError,
  getEmployeeInstance,
  updateEmployeeInstance,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId =
      new URL(request.url).searchParams.get('workspaceId') ??
      context.workspaceId;
    return Response.json({
      instance: await getEmployeeInstance(
        { ...context, workspaceId },
        (await params).id,
      ),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({
      instance: await updateEmployeeInstance(
        context,
        (await params).id,
        await request.json(),
      ),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
