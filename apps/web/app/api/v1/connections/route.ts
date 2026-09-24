import {
  MemberConnectionMutationSchema,
  McpError,
  UuidSchema,
  isMcpInputValidationError,
} from '@allrice/contracts';
import { createMcpStore, DataAccessError } from '@allrice/database';
import { requireRequestContext } from '../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../lib/identity/request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  const status =
    error instanceof DataAccessError
      ? error.code === 'authentication_required'
        ? 401
        : 403
      : error instanceof McpError && error.code === 'MCP_DENIED'
        ? 403
        : isMcpInputValidationError(error) || error instanceof SyntaxError
          ? 400
          : 503;
  return Response.json(
    {
      error: {
        message:
          status === 403
            ? '请登录并确认这是你的应用连接。'
            : '连接暂未完成，请稍后重试。',
      },
    },
    { status, headers },
  );
}
export async function GET(request: Request) {
  try {
    const context = await requireRequestContext(request);
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    return Response.json(
      {
        connections: await createMcpStore({ memberManaged: true }).list(
          context,
          workspaceId,
        ),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    if (
      !sameOriginBrowserWrite(request) ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      throw new McpError('MCP_DENIED');
    const context = await requireRequestContext(request);
    const reader = request.body?.getReader();
    if (!reader) throw new McpError('MCP_DENIED');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16_384) {
          await reader.cancel();
          return new Response(null, { status: 413, headers });
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const input = MemberConnectionMutationSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    const store = createMcpStore({ memberManaged: true });
    const connection =
      input.action === 'login'
        ? await store.beginOAuth(context, {
            ...input,
            redirectUrl: new URL(
              '/api/v1/connections/callback',
              request.headers.get('origin')!,
            ).href,
          })
        : input.action === 'credential'
          ? await store.rotate(context, input)
          : await store.setMemberConnected(context, {
              ...input,
              connected: input.action === 'reconnect',
              remove: input.action === 'delete',
            });
    return Response.json({ connection }, { headers });
  } catch (error) {
    return failure(error);
  }
}
