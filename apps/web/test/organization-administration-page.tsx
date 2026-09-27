import { RuntimeConsole } from '../app/runtime-console/runtime-console';
import { createRoot } from 'react-dom/client';
import { OrganizationActivity } from '../app/runtime-console/organization-activity';
import { OrganizationAdministration } from '../app/runtime-console/organization-administration';
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(window.location.search).get('view') === 'activity' ? (
    <OrganizationActivity />
  ) : new URLSearchParams(window.location.search).get('view') === 'runtimes' ? (
    <RuntimeConsole />
  ) : (
    <OrganizationAdministration />
  ),
);
