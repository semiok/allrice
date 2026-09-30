import { createMcpStore } from '@allrice/database';
import { GITHUB_MCP_CALLBACK_PATH } from '@allrice/contracts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const headers = {
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  };
  try {
    const query = new URL(request.url).searchParams;
    // The proxy admits only known portal hosts. The saved callback must match
    // this host exactly; no forwarding header or query controls the destination.
    const callbackUrl = new URL(
      GITHUB_MCP_CALLBACK_PATH,
      `https://${request.headers.get('host') ?? new URL(request.url).host}`,
    ).href;
    const location = await createMcpStore().githubOAuthReturn({
      state: query.get('state') ?? '',
      ...(query.has('code') ? { code: query.get('code')! } : {}),
      ...(query.has('error') ? { error: query.get('error')! } : {}),
      callbackUrl,
    });
    return new Response(null, {
      status: 302,
      headers: { ...headers, Location: location },
    });
  } catch {
    return new Response('GitHub 登录未完成或已过期，请返回已连接应用重试。', {
      status: 400,
      headers,
    });
  }
}
