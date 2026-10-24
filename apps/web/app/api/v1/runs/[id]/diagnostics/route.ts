import { cookies } from 'next/headers';
import { DataAccessError, getRun } from '@allrice/database';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import {
  NativeDiagnosticsUnavailable,
  requestNativeRunDiagnostics,
} from '../../../../../../lib/execution/native-run-diagnostics';
import {
  requireRequestContext,
  sessionCookieName,
} from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireRequestContext(request);
    const workspaceId = new URL(request.url).searchParams.get('workspaceId');
    if (!workspaceId) throw new DataAccessError('not_found');
    const { id } = await route.params;
    const run = await getRun(context, workspaceId, id);
    if (context.actor.type !== 'user' || context.actor.id !== run.ownerId)
      throw new DataAccessError('not_found');
    const token = (await cookies()).get(sessionCookieName)?.value;
    if (!token) throw new DataAccessError('authentication_required');
    const diagnostics = await requestNativeRunDiagnostics({
      token,
      context,
      workspaceId,
      runId: id,
      signal: request.signal,
    });
    return Response.json(
      { diagnostics },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof NativeDiagnosticsUnavailable) {
      if (error.status === 401)
        return executionErrorResponse(
          new DataAccessError('authentication_required'),
        );
      if (error.status === 404)
        return executionErrorResponse(new DataAccessError('not_found'));
      return Response.json(
        { error: 'NATIVE_DIAGNOSTICS_UNAVAILABLE' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
    return executionErrorResponse(error);
  }
}
