import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRequestContext } from '../../../lib/identity/session';
import { McpSettings } from '../../runtime-console/mcp-settings';

export const dynamic = 'force-dynamic';

export default async function WorkspaceMcpPage() {
  const requestHeaders = await headers();
  const context = await getRequestContext(
    new Request('http://localhost/workspace/mcp', { headers: requestHeaders }),
  );
  if (!context?.workspaceId) redirect('/login');
  if (
    !context.memberships.some(
      (m) =>
        m.active &&
        m.userId === context.actor.id &&
        m.organizationId === context.organizationId &&
        (m.workspaceId === null || m.workspaceId === context.workspaceId) &&
        m.role === 'admin',
    )
  )
    return (
      <main>
        <Link href="/chatflow">返回工作台</Link>
        <p>只有当前租户管理员可以管理 MCP 连接。</p>
      </main>
    );
  return (
    <main>
      <Link href="/chatflow">← 返回工作台</Link>
      <h1>当前租户的 MCP 连接</h1>
      <McpSettings workspaceId={context.workspaceId} />
    </main>
  );
}
