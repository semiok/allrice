import {
  DataAccessError,
  previewPersonalSceneRestore,
  restorePersonalSceneFile,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
async function handle(request: Request, id: string, commit: boolean) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const input: unknown = await request.json();
    const result = commit
      ? { receipt: await restorePersonalSceneFile(context, id, input) }
      : await previewPersonalSceneRestore(context, id, input);
    return Response.json(result, { headers });
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
}
/** Read the exact old package and current target without mutating either. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(request, (await params).id, false);
}
/** Human confirmation appends one revision through the existing writer. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(request, (await params).id, true);
}
