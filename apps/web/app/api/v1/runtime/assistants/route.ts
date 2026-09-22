import { UuidSchema, AssistantControlActionSchema } from '@allrice/contracts';
import {
  AssistantRuntimeError,
  createAssistantRuntime,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { isRequestValidationError } from '../../../../../lib/api-error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

async function handle(request: Request, write: boolean) {
  if (write && !sameOriginBrowserWrite(request))
    return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
  try {
    const context = await getRequestContext(request);
    if (!context) return new Response(null, { status: 401, headers });
    const url = new URL(request.url);
    const workspaceId = UuidSchema.parse(url.searchParams.get('workspaceId'));
    const scoped = { ...context, workspaceId };
    // OFF prohibits new admissions, not historical reads or stopping work.
    // No user-supplied authority hook: database methods check actual ownership.
    const service = createAssistantRuntime();
    if (!write && url.searchParams.has('sessionId')) {
      if (url.searchParams.has('runId'))
        return new Response(null, { status: 400, headers });
      const sessionId = UuidSchema.parse(url.searchParams.get('sessionId'));
      const beforeRootRunId = url.searchParams.has('beforeRootRunId')
        ? UuidSchema.parse(url.searchParams.get('beforeRootRunId'))
        : undefined;
      const trees = await service.getSessionTrees(scoped, {
        sessionId,
        ...(beforeRootRunId ? { beforeRootRunId } : {}),
        includeTiming: true,
      });
      return Response.json(
        {
          trees,
          nextCursor: trees.length === 20 ? trees.at(-1)!.rootRunId : null,
        },
        { headers },
      );
    }
    const runId = UuidSchema.parse(url.searchParams.get('runId'));
    if (!write)
      return Response.json(
        { tree: await service.getTree(scoped, { runId, includeTiming: true }) },
        { headers },
      );
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400, headers });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4_096) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const action = AssistantControlActionSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    const result =
      action.action === 'stop_child'
        ? await service.cancelChild(scoped, {
            runId,
            childRunId: action.childRunId,
            requestId: action.requestId,
          })
        : await service.cancelRoot(scoped, {
            runId,
            requestId: action.requestId,
          });
    return Response.json({ result }, { status: 202, headers });
  } catch (error) {
    const code =
      error instanceof AssistantRuntimeError
        ? error.code
        : isRequestValidationError(error) || error instanceof SyntaxError
          ? 'invalid_request'
          : 'unavailable';
    const status =
      code === 'not_found'
        ? 404
        : code === 'forbidden' || code === 'disabled'
          ? 403
          : code === 'invalid_request'
            ? 400
            : code === 'unavailable'
              ? 503
              : 409;
    return Response.json({ code }, { status, headers });
  }
}

export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
