// Browser acceptance entry only; not a Next route and not part of the product shell.
import { createRoot } from 'react-dom/client';
import { LocalCommandPanel } from '../app/chatflow/local-command-panel';
const props = JSON.parse(
  document.getElementById('p05-input')!.textContent!,
) as {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
};
createRoot(document.getElementById('root')!).render(
  <LocalCommandPanel {...props} />,
);
