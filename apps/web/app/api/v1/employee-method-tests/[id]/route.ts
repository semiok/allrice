import { DataAccessError, getEmployeeMethodTest } from '@allrice/database';
import { EmployeeMethodTestSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../lib/identity/session';
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
    return Response.json(
      EmployeeMethodTestSchema.parse(
        await getEmployeeMethodTest(
          { ...context, workspaceId },
          (await params).id,
        ),
      ),
    );
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
