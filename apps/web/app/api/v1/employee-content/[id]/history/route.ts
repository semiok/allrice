import { DataAccessError, getEmployeeContentHistory } from '@allrice/database';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../lib/employeehub/responses';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = new URL(request.url).searchParams;
    return Response.json(
      await getEmployeeContentHistory(
        {
          ...context,
          workspaceId: query.get('workspaceId') ?? context.workspaceId,
        },
        (await params).id,
        query.has('beforeRevision')
          ? Number(query.get('beforeRevision'))
          : undefined,
      ),
    );
  } catch (error) {
    return employeeHubErrorResponse(error);
  }
}
