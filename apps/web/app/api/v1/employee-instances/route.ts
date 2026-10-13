import {
  DataAccessError,
  createEmployeeInstance,
  listEmployeeHub,
} from '@allrice/database';
import { getRequestContext } from '../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId =
      new URL(request.url).searchParams.get('workspaceId') ?? undefined;
    const hub = await listEmployeeHub(context, workspaceId);
    return Response.json({
      instances: hub.assignments.flatMap((a) => a.instances ?? []),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      { instance: await createEmployeeInstance(context, await request.json()) },
      { status: 201 },
    );
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
