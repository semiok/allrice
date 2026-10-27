// Isolated Chromium page: real experience, local command and admin panels,
// synthetic HTTP. No DB, device or model. The test server supplies the root
// layout's global styles and the pre-paint theme script; a theme other than
// the surface default is applied with the runtime's own applyTheme.
import { createRoot } from 'react-dom/client';
import { ExperiencePanel } from '../app/workspace/experience/experience-panel';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { LocalCommandPanel } from '../app/chatflow/local-command-panel';
import { LocalMcpPanel } from '../app/chatflow/local-mcp-panel';
import { WorkbenchExperiencePanel } from '../app/chatflow/workbench-experience-panel';
import { OrganizationAiDirectory } from '../app/runtime-console/organization-ai-directory';
import { AdminShell } from '../components/admin/admin-shell';
import { applyTheme } from '../lib/theme/theme';
import { employeeDetailsFixture } from './employee-details-fixture';
import {
  adopted,
  candidates,
  directory,
  emptyWorkspace,
  employee,
  failingWorkspace,
  id,
  instance,
  mcpOperations,
  operations,
  organization,
  person,
  personInstances,
  provenance,
  summary,
  unfinished,
  workspace,
} from './experience-command-theme-fixtures';

// Writes (withdraw, approve) stay pending so their busy state can be seen.
const pending = new Promise<Response>(() => {});
const admin = `/api/v1/admin/organizations/${organization}`;
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.origin);
  const query = url.searchParams;
  if (init?.method && init.method !== 'GET') return pending;
  if (url.pathname === '/api/v1/experiences')
    return query.get('workspaceId') === failingWorkspace
      ? Response.json({}, { status: 500 })
      : query.get('workspaceId') === emptyWorkspace
        ? Response.json({ overview: null, candidates: [], draftBatches: [] })
        : Response.json({
            overview: {
              visibility: 'owner',
              workspaceId: workspace,
              instanceId: instance,
              summary,
            },
            candidates,
            draftBatches: [adopted, unfinished],
          });
  if (url.pathname.endsWith('/provenance')) return Response.json(provenance);
  if (url.pathname === `/api/v1/employee-instances/${instance}/content`)
    return Response.json(employeeDetailsFixture());
  if (url.pathname === '/api/v1/runtime/local-commands')
    return Response.json({ operations });
  if (url.pathname === '/api/v1/runtime/local-mcp')
    return Response.json({ operations: mcpOperations });
  if (url.pathname === `${admin}/departments`)
    return Response.json({ departments: [], nextCursor: null });
  if (url.pathname === `${admin}/ai-directory`) return Response.json(directory);
  if (url.pathname === `${admin}/people/${person}/ai-instances`)
    return Response.json(personInstances);
  if (
    url.pathname ===
    `${admin}/people/${person}/ai-instances/${instance}/content`
  )
    return Response.json({
      organizationId: organization,
      userId: person,
      visibility: 'shared_only',
      details: employeeDetailsFixture(),
      experienceSummary: summary,
    });
  return Response.json({}, { status: 404 });
};

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'light' || theme === 'dark') applyTheme(theme);

const headers = { 'x-test': 'synthetic' };
// The chat transcript and the workbench dock sit on the page surface.
const surface = {
  minHeight: '100vh',
  background: 'var(--ar-surface)',
  color: 'var(--ar-text)',
};
const transcript = { ...surface, maxWidth: 760, margin: '0 auto', padding: 16 };
const views = {
  // The standalone /workspace/experience page with records, without any,
  // and failing to read.
  page: (
    <>
      <ExperiencePanel workspaceId={workspace} />
      <ExperiencePanel workspaceId={emptyWorkspace} />
      <ExperiencePanel workspaceId={failingWorkspace} />
    </>
  ),
  // The workbench's experience module: adopted personal experience cards.
  workbench: (
    <div style={{ ...surface, height: '100vh' }}>
      <WorkbenchExperiencePanel
        scopeId={id(3)}
        workspaceId={workspace}
        instanceId={instance}
        employees={[{ id: instance, name: 'Rice' }]}
        headers={headers}
        active
        automatic
        onCorrect={() => {}}
      />
    </div>
  ),
  employee: (
    <EmployeeDetailsDialog
      open
      scopeId={id(3)}
      instanceId={instance}
      employeeId={employee}
      workspaceId={workspace}
      headers={headers}
      onClose={() => {}}
    />
  ),
  // The admin console: AI employees of one person, then their shared details.
  admin: (
    <AdminShell items={[]}>
      <OrganizationAiDirectory organizationId={organization} />
    </AdminShell>
  ),
  commands: (
    <div style={transcript}>
      <LocalCommandPanel
        runId={id(73)}
        workspaceId={workspace}
        tenantHeaders={headers}
        runActive={false}
      />
    </div>
  ),
  mcp: (
    <div style={transcript}>
      <LocalMcpPanel
        runId={id(73)}
        workspaceId={workspace}
        tenantHeaders={headers}
        runActive={false}
      />
    </div>
  ),
};
createRoot(document.getElementById('root')!).render(
  views[(params.get('view') ?? 'page') as keyof typeof views],
);
