import {
  localMcpEnabled,
  listLocalMcpOperations,
  cancelLocalCommandRun,
  RuntimePolicyError,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(request: Request, cancel: boolean) {
  if (!localMcpEnabled()) return new Response(null, { status: 404, headers });
  try {
    if (cancel && !sameOriginBrowserWrite(request))
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    const context = await getRequestContext(request);
    if (!context) return new Response(null, { status: 401, headers });
    const url = new URL(request.url),
      runId = url.searchParams.get('runId'),
      workspaceId = url.searchParams.get('workspaceId') ?? context.workspaceId;
    if (
      !UuidSchema.safeParse(runId).success ||
      !UuidSchema.safeParse(workspaceId).success
    )
      return Response.json(
        { code: 'INVALID_REQUEST' },
        { status: 400, headers },
      );
    const scoped = { ...context, workspaceId: workspaceId! };
    return Response.json(
      cancel
        ? await cancelLocalCommandRun(scoped, runId!)
        : { operations: await listLocalMcpOperations(scoped, runId!) },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        code:
          error instanceof RuntimePolicyError
            ? error.code
            : 'LOCAL_MCP_UNAVAILABLE',
      },
      { status: error instanceof RuntimePolicyError ? 403 : 500, headers },
    );
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
