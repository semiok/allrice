import { AppShell } from '../components/app-shell';
import { readFrameworkRolloutPolicy } from '../../lib/framework/rollout';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default function WorkspacePage() {
  if (process.env.ALLRICE_LEGACY_WORKSPACE_ENABLED === '0') {
    redirect('/chatflow');
  }
  return (
    <AppShell
      initialPanel="workspace"
      rolloutPolicy={readFrameworkRolloutPolicy()}
    />
  );
}
