/** Real product components on fixed synthetic props/read DTOs for UI preview.
 * No production API, database, model, upload or persistent write is connected. */
import { createRoot } from 'react-dom/client';
import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  defaultUserPreferences,
  EmployeeInstanceProfileSchema,
  ReferenceRevisionSchema,
  WorkbenchDeliverableSchema,
} from '@allrice/contracts';
import { FocusController } from '../components/theme/focus-controller';
import { EmployeeMemorySidebar } from '../app/chatflow/employee-memory-sidebar';
import {
  EmployeeProfileForm,
  employeeProfileFormFromRaw,
} from '../app/chatflow/employee-profile-form';
import { EmployeeCreateDialog } from '../app/chatflow/employee-create-dialog';
import { WorkbenchFilesPanel } from '../app/chatflow/workbench-files-panel';
import { EnterpriseMaterialsPanel } from '../app/chatflow/enterprise-materials-panel';
import { WorkspaceFilePickerDialog } from '../app/chatflow/workspace-file-picker-dialog';
import { ReferencePublicationDialog } from '../app/chatflow/reference-publication-dialog';
import { ReferenceLibrary } from '../app/chatflow/reference-library';
import { SessionReferencePicker } from '../app/chatflow/session-reference-picker';
import { CompanyTemplateBrowser } from '../app/chatflow/company-template-browser';
import { SidebarSettings } from '../app/chatflow/sidebar-settings';
import { AutomationTaskList } from '../app/chatflow/automation-tasks';
import { WorkspaceFilePreview } from '../app/chatflow/workspace-file-preview';
import {
  employeeAccent,
  employeeAccentStyle,
} from '../app/chatflow/employee-navigation';
import { employeeDetailsFixture } from './employee-details-fixture';
import { applyTheme } from '../lib/theme/theme';
import type { Workspace, WorkspaceFile } from '../app/chatflow/chatflow-types';
import frame from '../app/chatflow/dsh-upstream/AppFrame.module.css';
import conversation from '../app/chatflow/dsh-saas.module.css';
import workbench from '../app/chatflow/workbench.module.css';

type FocusControl = {
  id: string;
  selector?: string;
  label?: string;
  role?: string;
  name?: string;
  ownerSelector?: string;
  capture?: boolean;
};
type FocusAction = { selector?: string; role?: string; name?: string };
type PreviewItem = { name: string; preview: unknown };
declare global {
  interface Window {
    __focusCapture: {
      ready: boolean;
      case: string;
      controls: FocusControl[];
      actions?: FocusAction[];
      staticReason?: string;
      extraViews?: string[];
      reads: string[];
      writes: string[];
      unexpectedReads: string[];
      context: string;
    };
  }
}

const params = new URLSearchParams(location.search);
const caseName = params.get('case') ?? 'deliverables';
const mode = params.get('mode') ?? 'add';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
applyTheme(theme);
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const noop = () => {};
const deniedWrite = async () => {
  throw Error('Preview fixture does not perform writes');
};
const headers = {};
const workspaceId = id(2);
const viewerId = id(5);
const employees = [
  { id: id(7), name: 'Rice' },
  { id: id(17), name: '文案助理' },
];
const options = {
  workspaceId,
  platformMaintainer: false,
  maintenanceLevel: 'company' as const,
  writable: true,
  departmentId: null,
  departments: [
    { id: id(60), name: '财务部' },
    { id: id(61), name: '运营部' },
  ],
};
const digest = `sha256:${'a'.repeat(64)}`;
const file = WorkbenchDeliverableSchema.parse({
  objectId: id(90),
  workspaceId,
  fileName: '经营周报.md',
  mediaType: 'text/markdown',
  checksum: digest,
  sizeBytes: 3000,
  createdAt: '2026-11-12T08:00:00.000Z',
  ownedByMe: true,
  canMaintain: true,
  revision: 1,
  sharing: { scope: 'personal', departmentIds: [], departmentNames: [] },
  category: 'artifact',
  sessionIds: [],
  artifact: null,
  isReference: false,
  reference: null,
  origin: 'business-deliverable',
  favorite: false,
  canPublishReference: true,
  sources: [
    {
      sessionId: id(30),
      sessionTitle: '整理本周经营资料',
      employeeAssignmentId: id(6),
      employeeInstanceId: id(7),
      employeeName: 'Rice',
    },
  ],
});
const reference = ReferenceRevisionSchema.parse({
  sourceId: id(40),
  revisionId: id(41),
  revision: 1,
  ownership: { scope: 'company', organizationId: id(3) },
  fileName: '经营周报.md',
  purpose: '每月经营报告的格式参考',
  checksum: digest,
  sizeBytes: 3000,
  mediaType: 'text/markdown',
  status: 'active',
  processing: 'ready',
  failure: null,
  canMaintain: true,
  fullTextReady: true,
  publication: {
    origin: 'file',
    publisherId: viewerId,
    publisherName: '当前用户',
    audience: { scope: 'company', departmentIds: [] },
    audienceRevision: 1,
  },
  createdAt: '2026-11-12T08:00:00.000Z',
});
// Fixed capture time is 2026-11-15T20:00Z in America/Los_Angeles.
// Keep one old-day and one same-day row for the explicitly requested date format.
const todayFile = WorkbenchDeliverableSchema.parse({
  ...file,
  objectId: id(91),
  fileName: '本周进度.md',
  createdAt: '2026-11-15T18:30:00.000Z',
});
const todayReference = ReferenceRevisionSchema.parse({
  ...reference,
  sourceId: id(42),
  revisionId: id(43),
  fileName: '本周进度.md',
  purpose: '本周进度报告的格式参考',
  createdAt: '2026-11-15T18:30:00.000Z',
});
const details = employeeDetailsFixture();
const profile = {
  ...details.profile,
  editableFields: EmployeeInstanceProfileSchema.keyof().options,
};
const memory = {
  id: id(50),
  state: 'active' as const,
  summary: '报价规则：含税、PDF、文件名带客户和日期',
  details: '金额超过 5 万先发给我看，再发客户。',
  hasDetails: true,
  revision: 1,
  pairDigest: digest,
  capturedAt: '2026-11-12T08:00:00.000Z',
  updatedAt: '2026-11-12T08:00:00.000Z',
};
const workspace: Workspace = {
  viewerId,
  organizationId: id(3),
  workspaceId,
  employees: employees.map((item, index) => ({
    id: id(index + 6),
    employeeId: item.id,
    isDefault: index === 0,
    currentVersion: {
      id: id(index + 70),
      manifest: { name: item.name, description: '整理资料并交付文件。' },
    },
    versions: [],
  })),
  employeeProfiles: [],
  sessions: [],
  sessionModels: [],
  canAdminister: false,
};

const search = (id: string, name: string): FocusControl => ({
  id,
  name,
  selector: `input[aria-label="${name}"]`,
  ownerSelector: '[data-search-field]',
});
const select = (id: string, name: string): FocusControl => ({
  id,
  role: 'combobox',
  name,
  ownerSelector: '[data-select-field]',
});
const controls: Record<string, FocusControl[]> = {
  memory: [
    { id: 'summary', name: '一句话', selector: 'input[data-modal-autofocus]' },
    {
      id: 'details',
      name: '详细说明（选填）',
      selector: '[role="dialog"] textarea',
      capture: mode !== 'edit',
    },
  ],
  'employee-edit': [
    { id: 'name', label: '名字' },
    { id: 'mission', label: '使命' },
    { id: 'work-style', label: '工作方式', capture: false },
    {
      id: 'expression',
      label: '表达偏好',
      ownerSelector: '[data-select-field]',
    },
  ],
  'employee-create': [
    { id: 'name', label: '员工名字', capture: false },
    {
      id: 'expression',
      label: '表达偏好',
      ownerSelector: '[data-select-field]',
    },
  ],
  'file-picker': [search('search', '搜索文件名')],
  'reference-add': [{ id: 'purpose', label: '用途' }],
  'reference-audience': [],
  deliverables: [
    search('search', '查找文件'),
    select('employee', '按员工筛选'),
  ],
  materials: [search('search', '查找资料（文件名、用途、正文）')],
  automation: [
    search('search', '搜索自动化任务'),
    select('employee', '筛选员工'),
  ],
  settings: [
    { id: 'appearance', label: '外观', ownerSelector: '[data-select-field]' },
    {
      id: 'collapse-timing',
      label: '工作步骤收起时机',
      ownerSelector: '[data-select-field]',
      capture: false,
    },
  ],
  'legacy-references': [search('search', '查找参考资料')],
  'session-picker': [search('search', '搜索会话')],
  templates: [search('search', '查找范本'), select('category', '范本分类')],
};
const requiredRead: Record<string, string[]> = {
  deliverables: ['/api/v1/workbench/files'],
  materials: ['/api/v1/references/publications'],
  automation: ['/api/v1/scheduled-tasks'],
  'legacy-references': ['/api/v1/references'],
  'session-picker': ['/api/v1/sessions'],
  templates: ['/api/v1/company-assets'],
};
const reads: string[] = [];
const writes: string[] = [];
const unexpectedReads: string[] = [];
let mounted = false;
const actions =
  caseName === 'memory'
    ? mode === 'edit'
      ? [
          { selector: `button:has-text("${memory.summary}")` },
          { role: 'button', name: '修改' },
        ]
      : [{ role: 'button', name: '＋ 新增' }]
    : undefined;
function publish() {
  window.__focusCapture = {
    ready:
      mounted &&
      (requiredRead[caseName] ?? []).every((path) => reads.includes(path)),
    case: caseName,
    controls: controls[caseName] ?? [],
    actions,
    staticReason:
      caseName === 'reference-audience'
        ? '真实修改范围仅含radio/checkbox；用途不在该编辑入口。'
        : caseName.startsWith('canvas-')
          ? '真实交付成果预览；本项只减半固定padding，保留原生缩放和居中。'
          : undefined,
    extraViews:
      caseName === 'employee-create'
        ? ['dialog-top', 'dialog-bottom']
        : undefined,
    reads: [...reads],
    writes: [...writes],
    unexpectedReads: [...unexpectedReads],
    context:
      caseName === 'automation'
        ? 'Actual centerCol.employeeConversation with employeeAccentStyle(Rice, green); not a body-level neutral mount.'
        : 'Actual product components; synthetic props/read DTOs; no live backend.',
  };
}
publish();
const originalFetch = window.fetch.bind(window);
let canvasPreview: PreviewItem | undefined;
window.fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input), location.href);
  const method = init?.method ?? request?.method ?? 'GET';
  if (!url.pathname.startsWith('/api/v1/')) return originalFetch(input, init);
  if (!['GET', 'HEAD'].includes(method)) {
    writes.push(`${method} ${url.pathname}`);
    publish();
    return Response.json(
      { error: 'Preview fixture does not perform writes' },
      { status: 405 },
    );
  }
  let body: unknown;
  if (url.pathname.endsWith('/preview') && canvasPreview)
    body = canvasPreview.preview;
  else if (url.pathname === '/api/v1/workbench/files')
    body = {
      viewerId,
      files: [todayFile, file],
      employees,
      nextCursor: null,
      quotableFileIds: [file.objectId, todayFile.objectId],
    };
  else if (url.pathname === '/api/v1/references/publications')
    body = {
      viewerId,
      references: [todayReference, reference],
      options,
      nextCursor: null,
      matches: [],
      fullTextCoverage: { ready: 2, unavailable: 0 },
    };
  else if (url.pathname === '/api/v1/references')
    body = { references: [reference], options };
  else if (url.pathname === '/api/v1/scheduled-tasks')
    body = { tasks: [], nextCursor: null };
  else if (url.pathname === '/api/v1/sessions')
    body = { sessions: [], nextCursor: null };
  else if (url.pathname === '/api/v1/company-assets')
    body = {
      assets: [],
      nextCursor: null,
      ruleBudget: { maximumBytes: 10000, publishedBytes: 0, maximumRules: 100 },
    };
  else if (/^\/api\/v1\/employee-instances\/[^/]+\/content$/.test(url.pathname))
    body = details;
  else if (url.pathname === '/api/v1/experiences') body = { draftBatches: [] };
  else {
    unexpectedReads.push(url.pathname);
    publish();
    return Response.json(
      { error: 'Read is not declared in this preview fixture' },
      { status: 404 },
    );
  }
  reads.push(url.pathname);
  requestAnimationFrame(() => requestAnimationFrame(publish));
  return Response.json(body);
};

function CanvasPreview() {
  const [item, setItem] = useState<PreviewItem>();
  useEffect(() => {
    void originalFetch('/canvas-fixtures.json')
      .then((response) => response.json())
      .then((fixtures: Record<string, PreviewItem>) => {
        const next = fixtures[caseName.slice('canvas-'.length)];
        if (!next) throw Error('Canvas fixture missing');
        canvasPreview = next;
        setItem(next);
      });
  }, []);
  if (!item) return <p role="status">正在读取预览夹具…</p>;
  return (
    <div
      className={workbench.panel}
      style={{ height: '100dvh', width: '100%' }}
    >
      <WorkspaceFilePreview
        objectId={file.objectId}
        workspaceId={workspaceId}
        viewerId={viewerId}
        ownerKey="preview-fixture"
        title={item.name}
        tenantHeaders={headers}
        active
        unified
        deliverable={{ ...file, fileName: item.name }}
        quotable
        onBack={noop}
        onPublish={noop}
        fileActions={{ sessionId: id(30), onUse: noop }}
      />
    </div>
  );
}

function SettingsPreview() {
  const [section, setSection] = useState<string | null>('preferences');
  const preferences: ComponentProps<typeof SidebarSettings>['preferences'] = {
    scope: 'preview-fixture',
    value: { ...defaultUserPreferences, appearance: theme },
    pending: false,
    available: true,
    error: undefined,
    reload: async () => false,
    setPreferences: async () => false,
    setStreamingOutput: async () => false,
  };
  return (
    <SidebarSettings
      capabilities={() => null}
      collapsed={false}
      workspaceId={workspaceId}
      monthlyQuota={{ data: null, failed: false, reload: async () => {} }}
      preferences={preferences}
      section={section}
      onSectionChange={setSection}
      onBridge={noop}
      bridge={
        { bridgeOpen: false } as ComponentProps<
          typeof SidebarSettings
        >['bridge']
      }
      bridgeReleases={
        {} as ComponentProps<typeof SidebarSettings>['bridgeReleases']
      }
      onCapabilitiesChange={noop}
    />
  );
}

function Fixture() {
  useEffect(() => {
    mounted = true;
    requestAnimationFrame(() => requestAnimationFrame(publish));
  }, []);
  let content: ReactNode;
  if (caseName === 'memory')
    content = (
      <EmployeeMemorySidebar
        targetKey="preview-fixture"
        employeeName="Rice"
        rows={[memory]}
        onReload={noop}
        onReadDetail={async () => memory}
        onConfirm={deniedWrite}
        onDelete={deniedWrite}
        onSave={deniedWrite}
      />
    );
  else if (caseName === 'employee-edit')
    content = (
      <EmployeeProfileForm
        mode="edit"
        initialValue={employeeProfileFormFromRaw({}, profile)}
        onSubmit={deniedWrite}
        onCancel={noop}
      />
    );
  else if (caseName === 'employee-create')
    content = (
      <EmployeeCreateDialog
        workspace={workspace}
        headers={headers}
        onClose={noop}
        onCreated={noop}
      />
    );
  else if (caseName === 'file-picker')
    content = (
      <WorkspaceFilePickerDialog
        open
        files={[] as WorkspaceFile[]}
        employeeName="Rice"
        accentStyle={employeeAccentStyle('Rice', 'green')}
        attachedFileIds={[]}
        onAddFiles={deniedWrite}
        onClose={noop}
        onOpenVersionHistory={noop}
      />
    );
  else if (caseName === 'reference-add' || caseName === 'reference-audience')
    content = (
      <ReferencePublicationDialog
        workspaceId={workspaceId}
        viewerId={viewerId}
        headers={headers}
        options={options}
        target={
          caseName === 'reference-add'
            ? { kind: 'file', file }
            : { kind: 'audience', reference }
        }
        onClose={noop}
        onSaved={noop}
      />
    );
  else if (caseName === 'deliverables')
    content = (
      <WorkbenchFilesPanel
        workspaceId={workspaceId}
        ownerKey="preview-fixture"
        viewerId={viewerId}
        refreshKey="fixed"
        employees={employees}
        sessionId={null}
        headers={headers}
        active
        onOpen={noop}
        onUse={noop}
      />
    );
  else if (caseName === 'materials')
    content = (
      <EnterpriseMaterialsPanel
        ownerKey="preview-fixture"
        viewerId={viewerId}
        workspaceId={workspaceId}
        sessionId={null}
        headers={headers}
        active
        onUse={noop}
      />
    );
  else if (caseName === 'automation')
    content = (
      <section
        className={`${frame.centerCol} ${conversation.employeeConversation}`}
        data-employee-accent={employeeAccent('Rice', 'green')}
        style={{ ...employeeAccentStyle('Rice', 'green'), height: '100%' }}
      >
        <AutomationTaskList
          workspaceId={workspaceId}
          scope="preview-fixture"
          headers={headers}
          employees={employees}
          onSelect={noop}
          onNew={noop}
        />
      </section>
    );
  else if (caseName === 'settings') content = <SettingsPreview />;
  else if (caseName === 'legacy-references')
    content = (
      <ReferenceLibrary
        workspaceId={workspaceId}
        headers={headers}
        onClose={noop}
        hideUpload
      />
    );
  else if (caseName === 'session-picker')
    content = (
      <SessionReferencePicker
        workspaceId={workspaceId}
        activeId={null}
        headers={headers}
        selected={[]}
        onChange={noop}
        onClose={noop}
      />
    );
  else if (caseName === 'templates')
    content = (
      <CompanyTemplateBrowser
        open
        workspaceId={workspaceId}
        headers={headers}
        onClose={noop}
      />
    );
  else if (caseName.startsWith('canvas-')) content = <CanvasPreview />;
  else throw Error(`Unknown preview case: ${caseName}`);
  return (
    <>
      <FocusController />
      {caseName.startsWith('canvas-') ? (
        content
      ) : (
        <main
          style={{
            width: '100%',
            maxWidth: caseName === 'employee-edit' ? 600 : 1100,
            height: '100dvh',
            minWidth: 0,
            marginInline: 'auto',
            padding: caseName === 'automation' ? 0 : 16,
          }}
        >
          {content}
        </main>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
