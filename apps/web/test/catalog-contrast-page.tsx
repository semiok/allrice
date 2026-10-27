import type { CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AutomationCatalogTask, WorkbenchFile } from '@allrice/contracts';
import {
  AutomationTaskDetail,
  AutomationTaskList,
} from '../app/chatflow/automation-tasks';
import { AutomationTrigger } from '../app/chatflow/automation-trigger';
import { WorkbenchFilesPanel } from '../app/chatflow/workbench-files-panel';
import { ReferenceLibrary } from '../app/chatflow/reference-library';
import { SaveArtifactReference } from '../app/chatflow/save-artifact-reference';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import {
  EmployeeProfileForm,
  defaultEmployeeProfileFormValues,
} from '../app/chatflow/employee-profile-form';
import { BrandContentPanel } from '../app/chatflow/brand-content-panel';
import { PlatformReferenceLibrary } from '../app/runtime-console/platform-reference-library';
import { AdminShell } from '../components/admin/admin-shell';
import { LoginForm } from '../app/login/login-form';
import { applyTheme } from '../lib/theme/theme';
import { employeeDetailsFixture } from './employee-details-fixture';
// The root layout's global stylesheets, in its order.
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '../app/styles/auth.css';

/** Real components on static props and a synthetic fetch only: no server,
 * database, device or model. `?case=` picks one surface, `?theme=dark` the
 * dark theme as the runtime sets it. */
const params = new URLSearchParams(location.search);
const noop = () => {};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-26T01:00:00.000Z';
const workspaceId = id(2);
const digest = `sha256:${'a'.repeat(64)}`;

const task = (n: number, status: string): AutomationCatalogTask =>
  ({
    id: id(n),
    name: `每日工作提醒 ${n}`,
    prompt: '提醒我写日报',
    employeeId: id(4),
    employeeName: 'Rice',
    sessionId: id(5),
    sessionTitle: '日报',
    sourceArchived: false,
    createdAt: now,
    nextRunAt: '2026-11-01T01:00:00.000Z',
    canStop: true,
    revision: 1,
    definition: {
      kind: 'recurring',
      task: {
        id: id(n),
        name: `每日工作提醒 ${n}`,
        prompt: '提醒我写日报',
        sessionId: id(5),
        clientRequestId: id(n + 100),
        rule: { kind: 'daily', time: '09:00:00', timezone: 'Asia/Shanghai' },
        revision: 1,
        status,
        nextRunAt: '2026-11-01T01:00:00.000Z',
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        canManage: true,
        latestOccurrence: null,
      },
    },
  }) as AutomationCatalogTask;
const tasks = [task(40, 'enabled'), task(41, 'paused')];

const file: WorkbenchFile = {
  objectId: id(90),
  workspaceId,
  fileName: '十月经营周报.md',
  mediaType: 'text/markdown',
  checksum: digest,
  sizeBytes: 3000,
  createdAt: now,
  ownedByMe: true,
  canMaintain: true,
  revision: 1,
  sharing: { scope: 'personal', departmentIds: [], departmentNames: [] },
  category: 'artifact',
  sessionIds: [],
  artifact: null,
  isReference: false,
  reference: null,
};
const options = {
  workspaceId,
  // The admin console opens the library only for a platform maintainer.
  platformMaintainer: params.get('case') === 'admin',
  maintenanceLevel: 'personal',
  writable: true,
  departmentId: null,
  departments: [],
};

window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  const path = url.pathname;
  if (path === '/api/v1/scheduled-tasks')
    return Response.json({ tasks, nextCursor: null });
  if (path === `/api/v1/scheduled-tasks/${id(40)}`)
    return Response.json({
      task: tasks[0],
      occurrences: [
        {
          id: id(60),
          taskId: id(40),
          revision: 1,
          scheduledAt: '2026-10-25T01:00:00.000Z',
          status: 'succeeded',
          runId: id(61),
          sessionId: id(5),
          errorMessage: null,
        },
      ],
      nextCursor: null,
    });
  if (path === '/api/v1/workbench/files') {
    const query = url.searchParams.get('query');
    return Response.json({
      files: !query || file.fileName.includes(query) ? [file] : [],
      quotableFileIds: [],
      truncated: false,
      options: {
        writable: true,
        maintenanceLevel: 'personal',
        departmentId: null,
        departments: [],
      },
    });
  }
  if (path === '/api/v1/references')
    return Response.json({ references: [], options });
  if (path === '/api/v1/references/artifacts')
    return init?.method === 'POST'
      ? Response.json({ sourceId: id(70), revisionId: id(71) })
      : Response.json(options);
  if (path === `/api/v1/employee-instances/${id(7)}/content`)
    return Response.json(employeeDetailsFixture());
  // No brand yet: the panel opens on the empty brand form.
  if (path === `/api/v1/employee-instances/${id(7)}/brand-content`)
    return Response.json({ brands: [], board: null, packages: [], files: [] });
  return Response.json({ error: { message: '未知请求' } }, { status: 404 });
};

const cases: Record<string, ReactNode> = {
  automation: (
    <>
      <AutomationTaskList
        workspaceId={workspaceId}
        scope="synthetic"
        headers={{}}
        employees={[{ id: id(4), name: 'Rice' }]}
        onSelect={noop}
        onNew={noop}
      />
      <AutomationTaskDetail
        taskId={id(40)}
        active
        workspaceId={workspaceId}
        scope="synthetic"
        headers={{}}
        onOpenSession={noop}
      />
      <AutomationTrigger
        message={{
          id: id(80),
          role: 'user',
          status: 'completed',
          runId: null,
          createdAt: now,
          content: { text: '提醒我写日报' },
          source: {
            kind: 'schedule',
            taskId: id(40),
            scheduledAt: now,
            occurrenceId: id(60),
          },
        }}
        onOpen={noop}
      />
    </>
  ),
  files: (
    // The workbench gives the panel a fixed height beside the conversation.
    <div style={{ height: 640, minWidth: 0 }}>
      <WorkbenchFilesPanel
        workspaceId={workspaceId}
        sessionId={null}
        headers={{}}
        active
        onOpen={noop}
        onUse={noop}
      />
    </div>
  ),
  references: (
    <ReferenceLibrary workspaceId={workspaceId} headers={{}} onClose={noop} />
  ),
  save: (
    <SaveArtifactReference
      workspaceId={workspaceId}
      headers={{}}
      versionId={id(91)}
      fileName="十月经营周报.md"
      version={1}
    />
  ),
  employee: (
    <EmployeeDetailsDialog
      open
      scopeId="synthetic"
      instanceId={id(7)}
      employeeId={id(9)}
      workspaceId={workspaceId}
      headers={{}}
      onClose={noop}
    />
  ),
  forms: (
    <>
      <EmployeeProfileForm
        mode="create"
        initialValue={defaultEmployeeProfileFormValues}
        onSubmit={noop}
        onCancel={noop}
      />
      <BrandContentPanel
        workspaceId={workspaceId}
        instanceId={id(7)}
        employeeName="Rice"
        headers={{}}
        onClose={noop}
        onOpenSession={noop}
      />
    </>
  ),
  // The admin console's own palette, with a field of its own and the platform
  // reference library, whose dialog is portaled to <body>.
  admin: (
    <AdminShell items={[]}>
      <input aria-label="管理后台输入框" placeholder="管理后台输入框" />
      <PlatformReferenceLibrary />
    </AdminShell>
  ),
  // A field with no placeholder colour of its own, and the login form, whose
  // auth.css rule must still win over the shared one.
  shared: (
    <>
      <input aria-label="员工端输入框" placeholder="员工端输入框" />
      <div className="auth-shell auth-workspace">
        <LoginForm />
      </div>
    </>
  ),
};

// The runtime's own switch; styles/base.css does the rest (color-scheme,
// the dark canvas), as on a real page.
applyTheme(params.get('theme') === 'dark' ? 'dark' : 'light');
createRoot(document.getElementById('root')!).render(
  <main
    data-case={params.get('case')}
    style={
      {
        display: 'grid',
        gap: 24,
        padding: 16,
        minHeight: '100vh',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      } as CSSProperties
    }
  >
    {cases[params.get('case') ?? '']}
  </main>,
);
