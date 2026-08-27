import { AppShell } from '../components/app-shell';
import { readFrameworkRolloutPolicy } from '../../lib/framework/rollout';

export default function WorkspacePage() {
  return (
    <AppShell
      initialPanel="workspace"
      rolloutPolicy={readFrameworkRolloutPolicy()}
    />
  );
}
