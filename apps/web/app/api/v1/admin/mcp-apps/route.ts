import {
  getGithubMcpSettings,
  updateGithubMcpSettings,
  McpSettingsConflict,
} from '@allrice/database';
import { UpdateGithubMcpSettingsSchema } from '@allrice/contracts';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  try {
    return Response.json(
      {
        settings: await getGithubMcpSettings(
          await requirePlatformAdminContext(request),
        ),
      },
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function PUT(request: Request) {
  try {
    if (
      !sameOriginBrowserWrite(request) ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return Response.json(
        { error: { message: '请求来源无效' } },
        { status: 403, headers },
      );
    const context = await requirePlatformAdminContext(request);
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400, headers });
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
    const input = UpdateGithubMcpSettingsSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    // Register this platform's own callback, never an arbitrary external host.
    if (new URL(input.callbackUrl).origin !== request.headers.get('origin'))
      return Response.json(
        { error: { message: '回调地址必须使用当前管理后台的域名。' } },
        { status: 400, headers },
      );
    return Response.json(
      { settings: await updateGithubMcpSettings(context, input) },
      { headers },
    );
  } catch (error) {
    if (error instanceof McpSettingsConflict)
      return Response.json(
        { error: { message: '配置已更新，请刷新后重试。' } },
        { status: 409, headers },
      );
    return executionErrorResponse(error);
  }
}
