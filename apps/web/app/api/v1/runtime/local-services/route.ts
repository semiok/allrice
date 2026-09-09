import {
  localCommandFeatureEnabled,
  localServiceFeatureEnabled,
  localServiceUserAction,
  requestLocalPreviewFromUser,
  RuntimePolicyError,
} from '@allrice/database';
import {
  UuidSchema,
  RuntimeLocalServiceUserActionSchema,
} from '@allrice/contracts';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(request: Request, write: boolean) {
  if (!localCommandFeatureEnabled() || !localServiceFeatureEnabled())
    return new Response(null, { status: 404, headers });
  try {
    if (write && !sameOriginBrowserWrite(request))
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    const context = await getRequestContext(request);
    if (!context) return new Response(null, { status: 401, headers });
    const url = new URL(request.url);
    const processId = UuidSchema.parse(url.searchParams.get('processId'));
    const workspaceId = UuidSchema.parse(
      url.searchParams.get('workspaceId') ?? context.workspaceId,
    );
    let action: 'status' | 'stop' | 'input' | 'preview' = 'status';
    let input: unknown;
    if (write) {
      if (Number(request.headers.get('content-length') ?? 0) > 16_384)
        return new Response(null, { status: 413, headers });
      const reader = request.body?.getReader();
      let text = '';
      if (reader) {
        const decoder = new TextDecoder();
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 16_384) {
              await reader.cancel();
              return new Response(null, { status: 413, headers });
            }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      const body = RuntimeLocalServiceUserActionSchema.parse(JSON.parse(text));
      action = body.action;
      input = body.input;
    }
    if (action === 'preview') {
      return Response.json(
        await requestLocalPreviewFromUser(
          { ...context, workspaceId },
          processId,
        ),
        { headers },
      );
    }
    const runId = UuidSchema.parse(url.searchParams.get('runId'));
    return Response.json(
      {
        service: await localServiceUserAction(
          { ...context, workspaceId },
          runId,
          processId,
          action,
          input,
        ),
      },
      { headers },
    );
  } catch (error) {
    return Response.json(
      {
        code:
          error instanceof RuntimePolicyError
            ? error.code
            : 'SERVICE_REQUEST_DENIED',
      },
      {
        status: error instanceof Error && error.name === 'ZodError' ? 400 : 403,
        headers,
      },
    );
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
