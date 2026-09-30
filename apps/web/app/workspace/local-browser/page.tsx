import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { DataAccessError, resolveWorkspaceId } from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';

export const dynamic = 'force-dynamic';
export default async function WorkspaceLocalBrowserPage({
  searchParams,
}: { searchParams?: Promise<{ workspaceId?: string }> } = {}) {
  const context = await getRequestContext(
    new Request('http://localhost/workspace/local-browser', {
      headers: await headers(),
    }),
  );
  if (!context) redirect('/login');
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
        ['admin', 'member'].includes(m.role),
    )
  )
    return (
      <main>
        <Link href="/chatflow">返回工作台</Link>
        <p>当前账号没有此工作区的本地浏览器使用权限。</p>
      </main>
    );
  redirect('/chatflow?settings=computer');
}
