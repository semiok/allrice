import { PersonalSceneFileHistoryQuerySchema } from '@allrice/contracts';
import {
  DataAccessError,
  listPersonalSceneFileHistory,
  previewPersonalSceneFile,
} from '@allrice/database';
import { getRequestContext } from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { employeeHubErrorResponse } from '../../../../../../../lib/employeehub/responses';

export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const query = PersonalSceneFileHistoryQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return Response.json(
      await listPersonalSceneFileHistory(
        { ...context, workspaceId: query.workspaceId ?? context.workspaceId },
        (await params).id,
        query.beforeRevision,
      ),
      { headers },
    );
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
}

/** Parse and preview only. The existing scene-skills POST is the save entry. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json(
      await previewPersonalSceneFile(
        context,
        (await params).id,
        await request.json(),
      ),
      { headers },
    );
  } catch (error) {
    const response = employeeHubErrorResponse(error);
    Object.entries(headers).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  }
}
