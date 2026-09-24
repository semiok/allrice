import { createMcpStore } from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
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
    const location = await createMcpStore().oauthAuthorizationUrl(
      context,
      UuidSchema.parse(query.get('workspaceId')),
      UuidSchema.parse(query.get('connectionId')),
    );
    return new Response(null, {
      status: 302,
      headers: { ...headers, Location: location },
    });
  } catch {
    return new Response('登录链接已失效，请返回已连接应用重新登录。', {
      status: 403,
      headers,
    });
  }
}
