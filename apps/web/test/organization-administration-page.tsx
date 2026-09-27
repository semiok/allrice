import { createRoot } from 'react-dom/client';
import { OrganizationActivity } from '../app/runtime-console/organization-activity';
import { OrganizationAdministration } from '../app/runtime-console/organization-administration';
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(window.location.search).get('view') === 'activity' ? (
    <OrganizationActivity />
  ) : (
    <OrganizationAdministration />
  ),
);
