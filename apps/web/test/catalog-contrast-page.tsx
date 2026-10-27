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
import { employeeDetailsFixture } from './employee-details-fixture';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';

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
  platformMaintainer: false,
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
  // A field with no placeholder colour of its own, inside and outside the
  // admin console's palette.
  shared: (
    <>
      <input aria-label="员工端输入框" placeholder="员工端输入框" />
      <div data-admin-theme="dark">
        <input aria-label="管理后台输入框" placeholder="管理后台输入框" />
      </div>
    </>
  ),
};

if (params.get('theme') === 'dark') {
  // The runtime (#571) sets both; its base.css also turns on the dark
  // color-scheme for :root[data-theme='dark'], mirrored here until it lands.
  document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.style.colorScheme = 'dark';
  document.body.setAttribute('data-ds-dark-theme', '');
}
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
