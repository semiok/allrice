import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DataAccessError, resolveWorkspaceId } from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';
import { ConnectedApps } from './connected-apps';
import { LocalMcpSettings } from '../../runtime-console/local-mcp-settings';
import styles from './connected-apps.module.css';

export const dynamic = 'force-dynamic';

export default async function WorkspaceMcpPage({
  searchParams,
}: {
  searchParams?: Promise<{ workspaceId?: string; connectionId?: string }>;
} = {}) {
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
      <main className={styles.page}>
        <Link href="/chatflow">返回工作台</Link>
        <p role="alert">当前租户没有你可访问的工作区，无法管理应用连接。</p>
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
        ['admin', 'member'].includes(m.role),
    )
  )
    return (
      <main className={styles.page}>
        <Link href="/chatflow">返回工作台</Link>
        <p role="alert">当前账号没有此工作区的应用连接权限。</p>
      </main>
    );
  return (
    <main className={styles.page}>
      <Link href="/chatflow">← 返回工作台</Link>
      <h1>已连接应用</h1>
      <ConnectedApps
        workspaceId={workspaceId}
        connectionId={(await searchParams)?.connectionId}
      />
      {context.memberships.some(
        (m) =>
          m.active &&
          m.userId === context.actor.id &&
          m.organizationId === context.organizationId &&
          (m.workspaceId === null || m.workspaceId === workspaceId) &&
          m.role === 'admin',
      ) && (
        <details>
          <summary>本地应用高级设置</summary>
          <LocalMcpSettings workspaceId={workspaceId} />
        </details>
      )}
    </main>
  );
}
