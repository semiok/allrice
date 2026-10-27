// Isolated Chromium page: real experience and local command panels, synthetic
// HTTP. No DB, device or model.
import { createRoot } from 'react-dom/client';
import {
  ExperienceDraftCard,
  ExperiencePanel,
  ExperienceSummaryCard,
} from '../app/workspace/experience/experience-panel';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { LocalCommandPanel } from '../app/chatflow/local-command-panel';
import { employeeDetailsFixture } from './employee-details-fixture';
import {
  adopted,
  candidates,
  emptyWorkspace,
  employee,
  failingWorkspace,
  id,
  instance,
  operations,
  provenance,
  summary,
  unfinished,
  workspace,
} from './experience-command-theme-fixtures';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';

window.fetch = async (input) => {
  const url = new URL(String(input), location.origin);
  const query = url.searchParams;
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
  return Response.json({}, { status: 404 });
};

const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') {
  // The theme runtime sets both (#571, not on main yet).
  document.documentElement.setAttribute('data-theme', 'dark');
  document.body.setAttribute('data-ds-dark-theme', '');
}
// #571's base.css paints the dark canvas on body; mirrored until it lands.
const runtime = document.createElement('style');
runtime.textContent = `:root[data-theme='dark']{color-scheme:dark;background:transparent}
body[data-ds-dark-theme]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}`;
document.head.append(runtime);

const headers = { 'x-test': 'synthetic' };
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
  // Cards lent to other surfaces without the page around them.
  cards: (
    <div style={{ padding: 16 }}>
      <ExperienceSummaryCard summary={summary} shared />
      <ExperienceDraftCard
        activeOnly
        batch={adopted}
        sourceContext={{ workspaceId: workspace, headers }}
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
  // A transcript surface, as the chat lays the card out.
  commands: (
    <div
      style={{
        maxWidth: 760,
        margin: '0 auto',
        padding: 16,
        minHeight: '100vh',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <LocalCommandPanel
        runId={id(73)}
        workspaceId={workspace}
        tenantHeaders={headers}
        runActive={false}
      />
    </div>
  ),
};
createRoot(document.getElementById('root')!).render(
  <main>{views[(params.get('view') ?? 'page') as keyof typeof views]}</main>,
);
