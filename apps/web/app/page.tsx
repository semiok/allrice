import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { portalAuthEnabled, resolvePortal } from '../lib/portal/config';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  if (portalAuthEnabled()) {
    const portal = resolvePortal((await headers()).get('host'));
    if (portal) redirect(portal.homePath);
  }
  redirect('/chatflow');
}
