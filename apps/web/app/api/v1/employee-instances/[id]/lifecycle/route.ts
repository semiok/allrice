import {
  DataAccessError,
  changeEmployeeInstanceLifecycle,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({
      instance: await changeEmployeeInstanceLifecycle(
        context,
        (await params).id,
        await request.json(),
      ),
    });
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
