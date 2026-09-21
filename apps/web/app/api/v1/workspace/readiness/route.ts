import { UuidSchema } from '@allrice/contracts';
import { DataAccessError, getWorkspaceReadiness } from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context)
      return Response.json(
        { code: 'AUTHENTICATION_REQUIRED' },
        { status: 401, headers },
      );
    const url = new URL(request.url);
    const workspace = UuidSchema.safeParse(url.searchParams.get('workspaceId'));
    const sessionId = url.searchParams.get('sessionId');
    if (
      !workspace.success ||
      (sessionId !== null && !UuidSchema.safeParse(sessionId).success)
    )
      return Response.json(
        { code: 'INVALID_REQUEST' },
        { status: 400, headers },
      );
    return Response.json(
      await getWorkspaceReadiness(context, workspace.data, sessionId),
      { headers },
    );
  } catch (error) {
    const status =
      error instanceof DataAccessError
        ? error.code === 'authentication_required'
          ? 401
          : error.code === 'not_found'
            ? 404
            : 403
        : 503;
    // No raw DB/configuration errors or target credentials in the response/log.
    return Response.json(
      { code: status === 503 ? 'READINESS_UNAVAILABLE' : 'READINESS_DENIED' },
      { status, headers },
    );
  }
}
