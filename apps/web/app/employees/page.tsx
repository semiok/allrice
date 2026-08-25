import { AppShell } from '../components/app-shell';
import { readFrameworkRolloutPolicy } from '../../lib/framework/rollout';

export default function EmployeesPage() {
  return (
    <AppShell
      initialPanel="employees"
      rolloutPolicy={readFrameworkRolloutPolicy()}
    />
  );
}
