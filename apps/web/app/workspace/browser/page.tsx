import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  DataAccessError,
  RuntimePolicyError,
  resolveWorkspaceId,
  listBrowserControlManagement,
} from '@allrice/database';
import { getRequestContext } from '../../../lib/identity/session';
import { BrowserControlSettings } from './settings';
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
    const workspaceId = requested
      ? await resolveWorkspaceId(context, requested)
      : await resolveWorkspaceId(context);
    await listBrowserControlManagement({ ...context, workspaceId });
    return (
      <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
        <Link href="/chatflow">← 返回工作台</Link>
        <h1>云端浏览器授权</h1>
        <BrowserControlSettings workspaceId={workspaceId} />
      </main>
    );
  } catch (error) {
    if (
      !(error instanceof DataAccessError) &&
      !(error instanceof RuntimePolicyError)
    )
      throw error;
    return (
      <main>
        <Link href="/chatflow">返回工作台</Link>
        <p role="alert">当前工作区不可用，或你不是当前租户管理员。</p>
      </main>
    );
  }
}
