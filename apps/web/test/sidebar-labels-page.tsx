import { createRoot } from 'react-dom/client';
import type {
  Employee,
  Session,
  Workspace,
} from '../app/chatflow/chatflow-types';
import { EmployeePickerDialog } from '../app/chatflow/employee-picker-dialog';
import { EmployeeSidebar } from '../app/chatflow/employee-sidebar';
import { WorkbenchEntries } from '../app/chatflow/workbench-modules';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';

/** Static props only: no server, database, device or model. */
const noop = () => {};
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'dark') {
  // What the dark runtime sets: both attributes, and the dark colour scheme
  // its :root[data-theme='dark'] rule applies (#571).
  document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.style.colorScheme = 'dark';
  document.body.setAttribute('data-ds-dark-theme', '');
}

const employee = (id: string, name: string, isDefault: boolean): Employee => ({
  id,
  employeeId: id,
  isDefault,
  currentVersion: {
    id: `${id}-v1`,
    manifest: { name, description: `${name}负责整理资料并交付文件。` },
  },
  versions: [],
});
const minutesAgo = (n: number) =>
  new Date(Date.now() - n * 60_000).toISOString();
const session = (id: string, title: string, updatedAt: string): Session => ({
  id,
  title,
  employeeAssignmentId: 'rice',
  employeeVersionId: 'rice-v1',
  visibility: 'private',
  updatedAt,
  archivedAt: null,
});
const sessions = [
  session('weekly', '整理本周销售周报', minutesAgo(26)),
  session('budget', '核对十月预算', minutesAgo(90)),
];
const workspace: Workspace = {
  viewerId: 'viewer',
  organizationId: 'org',
  workspaceId: 'work',
  employees: [
    employee('rice', 'Rice', true),
    employee('writer', '文案助理', false),
  ],
  employeeProfiles: [],
  sessions,
  sessionModels: [],
  canAdminister: false,
};
// The second employee is open with no work yet, so its empty hint shows.
localStorage.setItem(
  'allrice.employee-tree.v1:org:work:viewer',
  JSON.stringify({ writer: true }),
);

createRoot(document.getElementById('root')!).render(
  <main style={{ minHeight: '100vh', background: 'var(--dsw-alias-bg-base)' }}>
    <header
      style={{ display: 'flex', justifyContent: 'flex-end', padding: 12 }}
    >
      <WorkbenchEntries
        counts={{ files: 1, experience: 0, workflow: 0 }}
        workflow={false}
        experience={false}
        open={false}
        onOpen={noop}
        onToggle={noop}
      />
    </header>
    {/* The sidebar paints --allrice-sidebar-bg through DSH's sidebar fill. */}
    <aside
      style={{
        width: 'min(280px, 100%)',
        background: 'var(--allrice-sidebar-bg)',
      }}
    >
      <EmployeeSidebar
        workspace={workspace}
        sessions={sessions}
        activeId="weekly"
        collapsed={false}
        onSelectSession={noop}
        onPrepareSession={noop}
        onDetails={noop}
      />
    </aside>
    {params.get('dialog') === 'picker' && (
      <EmployeePickerDialog
        workspace={workspace}
        headers={{}}
        onClose={noop}
        onSelect={noop}
        onCreated={noop}
      />
    )}
  </main>,
);
