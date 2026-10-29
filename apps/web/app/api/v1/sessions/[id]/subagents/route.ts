import { cookies } from 'next/headers';
import { NativeSubagentQueryRequestSchema } from '@allrice/contracts';
import { authorizeSessionOwner, DataAccessError } from '@allrice/database';
import {
  requireRequestContext,
  sessionCookieName,
} from '../../../../../../lib/identity/session';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import {
  NativeDiagnosticsUnavailable,
  requestNativeSubagentSummary,
} from '../../../../../../lib/execution/native-run-diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireRequestContext(request);
    const { workspaceId } = NativeSubagentQueryRequestSchema.pick({
      workspaceId: true,
    }).parse(Object.fromEntries(new URL(request.url).searchParams));
    const { id } = await route.params;
    await authorizeSessionOwner(context, workspaceId, id);
    const token = (await cookies()).get(sessionCookieName)?.value;
    if (!token) throw new DataAccessError('authentication_required');
    const summary = await requestNativeSubagentSummary({
      token,
      context,
      workspaceId,
      sessionId: id,
      signal: request.signal,
    });
    return Response.json(
      { summary },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof NativeDiagnosticsUnavailable) {
      if (error.status === 401 || error.status === 404)
        return executionErrorResponse(
          new DataAccessError(
            error.status === 401 ? 'authentication_required' : 'not_found',
          ),
        );
      return Response.json(
        { error: 'NATIVE_SUBAGENT_SUMMARY_UNAVAILABLE' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    }
    return executionErrorResponse(error);
  }
}
