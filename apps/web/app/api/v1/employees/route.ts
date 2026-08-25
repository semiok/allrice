import {
  createEmployee,
  DataAccessError,
  listEmployeeHub,
  publishEmployeeVersion,
} from '@allrice/database';

import { employeeHubErrorResponse } from '../../../../lib/employeehub/responses';
import { getRequestContext } from '../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    return Response.json({
      employeeHub: await listEmployeeHub(context, workspaceId ?? undefined),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input = await request.json();
    if (typeof input?.employeeId === 'string') {
      const version = await publishEmployeeVersion(context, input);
      return Response.json({ version }, { status: 201 });
    }
    const employee = await createEmployee(context, input);
    return Response.json({ employee }, { status: 201 });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
