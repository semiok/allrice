import { UuidSchema } from '@allrice/contracts';
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
    const destination = new URLSearchParams({ settings: 'apps' });
    const sessionId = UuidSchema.safeParse(result.returnSessionId).data;
    if (sessionId) destination.set('session', sessionId);
    return new Response(null, {
      status: 302,
      headers: {
        ...headers,
        Location: `/chatflow?${destination}`,
      },
    });
  } catch {
    return new Response('应用登录未完成或已过期，请返回已连接应用重试。', {
      status: 400,
      headers,
    });
  }
}
