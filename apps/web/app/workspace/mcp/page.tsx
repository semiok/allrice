import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DataAccessError, resolveWorkspaceId } from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';
import { McpSettings } from '../../runtime-console/mcp-settings';
import { LocalMcpSettings } from '../../runtime-console/local-mcp-settings';

export const dynamic = 'force-dynamic';

export default async function WorkspaceMcpPage({
  searchParams,
}: { searchParams?: Promise<{ workspaceId?: string }> } = {}) {
  const requestHeaders = await headers();
  const context = await getRequestContext(
    new Request('http://localhost/workspace/mcp', { headers: requestHeaders }),
  );
  if (!context) redirect('/login');
  // Email/password sessions are organization-scoped until a workspace is
  // selected. Resolve an accessible workspace without provisioning employees
  // or writing workspace state merely by visiting the settings page.
  let workspaceId: string;
  try {
    const requested = (await searchParams)?.workspaceId;
    workspaceId = requested
      ? await resolveWorkspaceId(context, requested)
      : await resolveWorkspaceId(context);
  } catch (error) {
    if (
      !(error instanceof DataAccessError) ||
      error.code !== 'authorization_denied'
    )
      throw error;
    return (
      <main>
        <Link href="/chatflow">返回工作台</Link>
        <p role="alert">当前租户没有你可访问的工作区，无法管理 MCP 连接。</p>
      </main>
    );
  }
  if (
    !context.memberships.some(
      (m) =>
        m.active &&
        m.userId === context.actor.id &&
        m.organizationId === context.organizationId &&
        (m.workspaceId === null || m.workspaceId === workspaceId) &&
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
      <McpSettings workspaceId={workspaceId} />
      <LocalMcpSettings workspaceId={workspaceId} />
    </main>
  );
}
