import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  DataAccessError,
  RuntimePolicyError,
  resolveWorkspaceId,
} from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';
export const dynamic = 'force-dynamic';
export default async function BrowserSettingsPage({
  searchParams,
}: { searchParams?: Promise<{ workspaceId?: string }> } = {}) {
  const context = await getRequestContext(
    new Request('http://localhost/workspace/browser', {
      headers: await headers(),
    }),
  );
  if (!context) redirect('/login');
  try {
    const requested = (await searchParams)?.workspaceId;
    await resolveWorkspaceId(context, requested);
    redirect('/chatflow?settings=work');
  } catch (error) {
    if (
      !(error instanceof DataAccessError) &&
      !(error instanceof RuntimePolicyError)
    )
      throw error;
    return (
      <main>
        <Link href="/chatflow">返回工作台</Link>
        <p role="alert">
          暂时无法访问当前工作区，请返回工作台选择可用的工作区。
        </p>
      </main>
    );
  }
}
