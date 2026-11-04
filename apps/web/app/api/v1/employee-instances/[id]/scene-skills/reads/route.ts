import { DataAccessError, listPersonalSceneReads } from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      await listPersonalSceneReads(
        context,
        (await params).id,
        Object.fromEntries(new URL(request.url).searchParams),
      ),
      {
        headers: {
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  }
}
