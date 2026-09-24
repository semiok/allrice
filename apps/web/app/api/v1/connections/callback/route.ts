import { createMcpStore } from '@allrice/database';
import { requireRequestContext } from '../../../../../lib/identity/session';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const headers = {
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  };
  try {
    const context = await requireRequestContext(request);
    const query = new URL(request.url).searchParams;
    const result = await createMcpStore().completeOAuthCallback(context, {
      state: query.get('state') ?? '',
      code: query.get('code') ?? '',
    });
    return new Response(null, {
      status: 302,
      headers: {
        ...headers,
        Location: `/workspace/mcp?workspaceId=${result.workspaceId}&connectionId=${result.connectionId}`,
      },
    });
  } catch {
    return new Response('应用登录未完成或已过期，请返回已连接应用重试。', {
      status: 400,
      headers,
    });
  }
}
