// Isolated real tenant/owner/shared detail entry; synthetic HTTP, no auth bypass.
import { createRoot } from 'react-dom/client';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { useThemeSync } from '../components/theme/theme-controller';
import { setAppearance } from '../lib/theme/appearance';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
setAppearance(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
function Fixture() {
  useThemeSync(location.pathname);
  return new URLSearchParams(location.search).has('shared') ? (
    <EmployeeDetailsDialog
      open
      scopeId={`${id(3)}/${id(4)}/${id(5)}`}
      workspaceId={id(4)}
      instanceId={id(17)}
      headers={{}}
      organizationView={{ organizationId: id(3), userId: id(5) }}
      onArchive={() => {
        throw new Error('Shared details cannot offer owner archival');
      }}
      onClose={() => history.back()}
    />
  ) : (
    <ChatFlowClient workbenchEnabled taskSuggestionsEnabled={false} />
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
