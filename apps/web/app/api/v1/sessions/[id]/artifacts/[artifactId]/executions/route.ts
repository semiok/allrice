import {
  changesetFeatureEnabled,
  listChangesetRuns,
  getChangesetRun,
  cancelRun,
  cancelLocalCommandRun,
} from '@allrice/database';
import { UuidSchema, ChangesetRunsResponseSchema } from '@allrice/contracts';
import { getRequestContext } from '../../../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
type Route = { params: Promise<{ id: string; artifactId: string }> };
async function handle(request: Request, route: Route, cancel: boolean) {
  if (!changesetFeatureEnabled())
    return new Response(null, { status: 404, headers });
  if (cancel && !sameOriginBrowserWrite(request))
    return new Response(null, { status: 403, headers });
  try {
    const login = await getRequestContext(request);
    if (!login) return new Response(null, { status: 401, headers });
    const p = await route.params,
      sessionId = UuidSchema.parse(p.id),
      artifactId = UuidSchema.parse(p.artifactId);
    const context = {
      ...login,
      workspaceId: UuidSchema.parse(
        new URL(request.url).searchParams.get('workspaceId') ??
          login.workspaceId,
      ),
    };
    const executions = await listChangesetRuns(context, sessionId, artifactId);
    if (!cancel)
      return Response.json(ChangesetRunsResponseSchema.parse({ executions }), {
        headers,
      });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400, headers });
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const n = await reader.read();
        if (n.done) break;
        size += n.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        chunks.push(n.value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 1 ||
      !('runId' in raw)
    )
      return new Response(null, { status: 400, headers });
    const runId = UuidSchema.parse(raw.runId);
    if (
      !executions.some((e) => e.runId === runId) ||
      !(await getChangesetRun(context, sessionId, runId))
    )
      return new Response(null, { status: 404, headers });
    await cancelRun(context, context.workspaceId, runId, {
      reason: '用户取消文件任务',
    });
    if (executions.some((e) => e.runId === runId && e.snapshot))
      await cancelLocalCommandRun(context, runId);
    return Response.json({ status: 'cancel_requested' }, { headers });
  } catch {
    return Response.json(
      { code: 'CHANGESET_REQUEST_UNAVAILABLE' },
      { status: 409, headers },
    );
  }
}
export const GET = (request: Request, route: Route) =>
  handle(request, route, false);
export const POST = (request: Request, route: Route) =>
  handle(request, route, true);
