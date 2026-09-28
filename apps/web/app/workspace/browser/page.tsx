import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getRequestContext } from '../../../lib/identity/session';
export const dynamic = 'force-dynamic';
export default async function BrowserSettingsPage() {
  const context = await getRequestContext(
    new Request('http://localhost/workspace/browser', {
      headers: await headers(),
    }),
  );
  if (!context) redirect('/login');
  // Cloud configuration is platform-managed. Tenant users inspect actual
  // availability in the same settings panel as their other capabilities.
  redirect('/chatflow?settings=capabilities');
}
