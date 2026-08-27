import { AppShell } from '../components/app-shell';
import { readFrameworkRolloutPolicy } from '../../lib/framework/rollout';

export default function AutomationPage() {
  return (
    <AppShell
      initialPanel="automation"
      rolloutPolicy={readFrameworkRolloutPolicy()}
    />
  );
}
