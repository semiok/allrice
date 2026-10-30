import { cookies } from 'next/headers';
import { z } from 'zod';
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
  requestNativeSubagentFollow,
} from '../../../../../../lib/execution/native-run-diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireRequestContext(request);
    const { workspaceId, liveOnly, follow, childId } =
      NativeSubagentQueryRequestSchema.pick({
        workspaceId: true,
        childId: true,
      })
        .extend({
          follow: z
            .literal('true')
            .transform(() => true)
            .optional(),
          liveOnly: z
            .literal('true')
            .transform(() => true)
            .optional(),
        })
        .parse(Object.fromEntries(new URL(request.url).searchParams));
    const { id } = await route.params;
    await authorizeSessionOwner(context, workspaceId, id);
    const token = (await cookies()).get(sessionCookieName)?.value;
    if (!token) throw new DataAccessError('authentication_required');
    if (follow)
      return await requestNativeSubagentFollow({
        token,
        context,
        workspaceId,
        sessionId: id,
        childId,
        signal: request.signal,
      });
    const summary = await requestNativeSubagentSummary({
      token,
      context,
      workspaceId,
      sessionId: id,
      liveOnly,
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
