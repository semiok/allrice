import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DataAccessError, resolveWorkspaceId } from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';
import { LocalBrowserSettings } from './local-browser-settings';

export const dynamic = 'force-dynamic';
export default async function WorkspaceLocalBrowserPage() {
  const context = await getRequestContext(
    new Request('http://localhost/workspace/local-browser', {
      headers: await headers(),
    }),
  );
  if (!context) redirect('/login');
  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspaceId(context);
  } catch (error) {
    if (
      !(error instanceof DataAccessError) ||
      error.code !== 'authorization_denied'
    )
      throw error;
    return (
      <main>
        <Link href="/chatflow">返回工作台</Link>
        <p role="alert">当前租户没有你可访问的工作区。</p>
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
        <p>只有当前租户管理员可以管理自己的本地浏览器授权。</p>
      </main>
    );
  return (
    <main>
      <LocalBrowserSettings workspaceId={workspaceId} />
    </main>
  );
}
