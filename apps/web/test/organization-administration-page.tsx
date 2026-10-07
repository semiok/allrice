import { WorkAdoption } from '../app/chatflow/work-adoption';
import { RuntimeConsole } from '../app/runtime-console/runtime-console';
import { createRoot } from 'react-dom/client';
import { OrganizationActivity } from '../app/runtime-console/organization-activity';
import { OrganizationAdministration } from '../app/runtime-console/organization-administration';
import adminStyles from '../components/admin/admin-ui.module.css';
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(window.location.search).get('view') === 'adoption' ? (
    <WorkAdoption
      headers={{}}
      workspaceId={new URLSearchParams(window.location.search).get(
        'workspaceId',
      )!}
      versionId={new URLSearchParams(window.location.search).get('versionId')!}
      runId={new URLSearchParams(window.location.search).get('runId')!}
      fileName={'验收报告.txt'}
    />
  ) : new URLSearchParams(window.location.search).get('view') === 'activity' ? (
    <div className={adminStyles.theme}>
      <OrganizationActivity />
    </div>
  ) : new URLSearchParams(window.location.search).get('view') === 'runtimes' ? (
    <RuntimeConsole />
  ) : (
    <div className={adminStyles.theme}>
      <OrganizationAdministration />
    </div>
  ),
);
