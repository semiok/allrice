import { cookies } from 'next/headers';
import {
  NativeSubagentControlInputSchema,
  NativeSubagentControlScopeSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  authorizeSessionOwner,
  DataAccessError,
  enqueueNativeSubagentControl,
  getNativeSubagentControl,
} from '@allrice/database';
import {
  requireRequestContext,
  sessionCookieName,
} from '../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
import { recoverNativeSubagentControlReceipt } from '../../../../../../../lib/execution/native-run-diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const body = NativeSubagentControlScopeSchema.pick({
  rootRunId: true,
  generation: true,
}).extend({ input: NativeSubagentControlInputSchema });
type Route = { params: Promise<{ id: string }> };
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'cache-control': 'private, no-store' },
  });
async function authorize(request: Request, route: Route) {
  const context = await requireRequestContext(request);
  const workspaceId = UuidSchema.parse(
    new URL(request.url).searchParams.get('workspaceId'),
  );
  const { id } = await route.params;
  await authorizeSessionOwner(context, workspaceId, id);
  return { context: { ...context, workspaceId }, id, workspaceId };
}
function failure(error: unknown) {
  if (
    error instanceof Error &&
    [
      'CHILD_CONTROL_CONFLICT',
      'CHILD_CONTROL_UNAVAILABLE',
      'final_delivery_evidence_unavailable',
    ].includes(error.message)
  )
    return json(
      {
        error: {
          code:
            error.message === 'CHILD_CONTROL_CONFLICT'
              ? 'CHILD_CONTROL_CONFLICT'
              : 'CHILD_CONTROL_UNAVAILABLE',
          message: '本次子任务控制无法提交，请刷新当前运行。',
        },
      },
      409,
    );
  return executionErrorResponse(error);
}

export async function POST(request: Request, route: Route) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const { context, id } = await authorize(request, route);
    const ticket = await enqueueNativeSubagentControl(
      context,
      id,
      body.parse(await request.json()),
    );
    return json({ ticket }, ticket.result.status === 'recorded' ? 202 : 200);
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request, route: Route) {
  try {
    const { context, id, workspaceId } = await authorize(request, route);
    const requestId = UuidSchema.parse(
      new URL(request.url).searchParams.get('requestId'),
    );
    let saved = await getNativeSubagentControl(context, id, requestId);
    if (!saved) throw new DataAccessError('not_found');
    if (
      saved.ticket.kind === 'prompt' &&
      saved.ticket.result.status === 'unknown'
    ) {
      const token = (await cookies()).get(sessionCookieName)?.value;
      if (token)
        await recoverNativeSubagentControlReceipt({
          token,
          context,
          workspaceId,
          sessionId: id,
          requestId,
          signal: request.signal,
        }).catch(() => {}); // No positive evidence leaves the original unknown.
      // Recheck current identity/owner after I/O; return only the C1 ticket.
      const current = await authorize(request, route);
      saved = await getNativeSubagentControl(current.context, id, requestId);
      if (!saved) throw new DataAccessError('not_found');
    }
    return json({ ticket: saved.ticket });
  } catch (error) {
    return failure(error);
  }
}
