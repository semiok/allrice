/** Real admin/login/MCP components on synthetic reads for visual preview only.
 * No production API, submit, database, model or persistent write is connected. */
import { createRoot } from 'react-dom/client';
import { useEffect, type ReactNode } from 'react';
import {
  McpConnectionSchema,
  OrganizationAiDirectorySchema,
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeSummarySchema,
  type ManagedOrganization,
  type OrganizationDepartment,
  type OrganizationPerson,
} from '@allrice/contracts';
import { OrganizationPeople } from '../app/runtime-console/organization-administration';
import { EmployeeProduction } from '../app/runtime-console/employee-production';
import { OrganizationAiDirectory } from '../app/runtime-console/organization-ai-directory';
import { ConnectedApps } from '../app/workspace/mcp/connected-apps';
import { LoginForm } from '../app/login/login-form';
import { FocusController } from '../components/theme/focus-controller';
import { applyTheme } from '../lib/theme/theme';
import admin from '../components/admin/admin-ui.module.css';

type Control = {
  id: string;
  selector?: string;
  label?: string;
  role?: string;
  name?: string;
  ownerSelector?: string;
};
const query = new URLSearchParams(location.search);
const caseName = query.get('case') ?? 'organization';
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
applyTheme(theme);
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const noop = () => {};
const timestamp = '2026-11-12T08:00:00.000Z';
const checksum = `sha256:${'a'.repeat(64)}`;
const company: ManagedOrganization = {
  id: id(1),
  name: '示例科技',
  slug: 'preview-company',
  businessContext: '固定合成资料，仅用于表单样式预览。',
  revision: 1,
  defaultWorkspaceId: id(2),
  workspaces: [{ id: id(2), name: '示例工作区', slug: 'preview-workspace' }],
  peopleCount: 2,
};
const departments: OrganizationDepartment[] = [
  {
    id: id(3),
    organizationId: company.id,
    name: '财务部',
    revision: 1,
    active: true,
    peopleCount: 1,
  },
  {
    id: id(4),
    organizationId: company.id,
    name: '运营部',
    revision: 1,
    active: true,
    peopleCount: 1,
  },
];
const people: OrganizationPerson[] = ['小雪', '小林'].map((name, index) => ({
  userId: id(index + 5),
  username: `preview-person-${index + 1}`,
  displayName: name,
  jobTitle: index === 0 ? '财务' : '运营',
  responsibilities: '整理经营资料与工作记录',
  email: null,
  status: 'active',
  membershipActive: true,
  departmentId: departments[index]!.id,
  departmentName: departments[index]!.name,
  contentMaintenanceLevel: 'personal',
  version: 'a'.repeat(32),
}));
const definition = PlatformEmployeeDefinitionSchema.parse({
  schemaVersion: 1,
  key: 'preview-assistant',
  name: '财务助理',
  description: '整理经营资料，核对信息并输出清晰结论。',
  appearance: { avatarType: 'initials', avatarValue: '财' },
  identity: {
    role: '财务助理',
    mission: '整理经营资料',
    workStyle: '先核对再交付',
    behaviorRules: ['说明依据与未知项'],
    safetyBoundaries: ['只用合成预览数据'],
    expressionStyle: 'structured',
    outputLanguage: 'zh-CN',
  },
  systemPrompt: 'Synthetic preview only.',
  modelPolicy: {
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'xhigh',
    timeoutMs: 300000,
    fallbackModels: [],
    credentialReference: 'preview-only',
    baseUrl: null,
  },
  capabilities: {
    nativeSkillIds: [],
    workflowRevisionIds: [],
    knowledgeRevisionIds: [],
    toolNames: [],
    connectorRefs: [],
  },
  securityPolicy: {
    dataScopes: ['workspace'],
    approvalPolicy: 'confirm_side_effects',
    bridgeAccess: 'none',
    connectorIdentityModes: [],
    deniedCapabilities: [],
  },
});
const employee = PlatformEmployeeSummarySchema.parse({
  id: id(10),
  employeeKey: definition.key,
  name: definition.name,
  description: definition.description,
  status: 'draft',
  currentDraft: {
    id: id(11),
    employeeId: id(10),
    revision: 1,
    status: 'draft',
    definition,
    runtimeProfile: null,
    checksum,
    createdAt: timestamp,
    publishedAt: null,
  },
  currentPublished: null,
  assignedWorkspaceIds: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const counts = {
  general: 1,
  custom: 0,
  inactive: 0,
  archived: 0,
  pendingAssignments: 0,
};
const directory = OrganizationAiDirectorySchema.parse({
  organizationId: company.id,
  totals: { ...counts, general: 2, people: 2 },
  people: people.map((person) => ({
    userId: person.userId,
    username: person.username,
    displayName: person.displayName,
    jobTitle: person.jobTitle,
    departmentId: person.departmentId,
    departmentName: person.departmentName,
    departmentActive: true,
    active: true,
    maintenanceLevel: 'personal',
    counts,
  })),
  nextCursor: null,
});
const connection = McpConnectionSchema.parse({
  id: id(20),
  definitionId: id(21),
  workspaceId: id(2),
  name: '示例工作资料',
  endpoint: 'https://mcp.preview.invalid/mcp',
  enabled: true,
  revision: 1,
  credentialConfigured: false,
  credentialReference: 'synthetic-preview-only',
  managed: true,
  shared: false,
  discoveryState: 'error',
  discoveryCode: 'MCP_AUTH_REQUIRED',
  checkedAt: null,
  tools: [],
});
const search = (
  name: string,
  ownerSelector = '[data-search-field]',
): Control => ({
  id: 'search',
  label: name,
  ownerSelector,
});
const select = (id: string, name: string): Control => ({
  id,
  label: name,
  ownerSelector: '[data-select-field]',
});
const controls: Record<string, Control[]> = {
  organization: [search('查找员工', '[data-search-field], form')],
  'organization-form': [
    { id: 'account', label: '英文账号' },
    { id: 'name', label: '姓名' },
    select('department', '主部门'),
    select('maintenance', '内容维护级别'),
  ],
  employees: [
    search('查找 AI 员工', '[data-search-field], label'),
    select('status', '员工发布状态'),
    { id: 'name', label: '名称' },
  ],
  directory: [search('查找员工'), select('department', '工作沉淀部门')],
  login: [
    { id: 'account', selector: 'input[name="username"]' },
    { id: 'password', selector: 'input[name="password"]' },
  ],
  mcp: [{ id: 'token', label: '应用访问令牌' }],
};
const requiredReads: Record<string, string[]> = {
  organization: [
    `/api/v1/admin/organizations/${company.id}/people`,
    `/api/v1/admin/organizations/${company.id}/departments`,
  ],
  'organization-form': [
    `/api/v1/admin/organizations/${company.id}/people`,
    `/api/v1/admin/organizations/${company.id}/departments`,
  ],
  employees: ['/api/v1/admin/platform-employees'],
  directory: [
    `/api/v1/admin/organizations/${company.id}/ai-directory`,
    `/api/v1/admin/organizations/${company.id}/departments`,
  ],
  login: [],
  mcp: ['/api/v1/connections'],
};
const actions =
  caseName === 'organization-form'
    ? [{ role: 'button', name: '添加员工' }]
    : caseName === 'mcp'
      ? [
          { selector: 'article summary' },
          { role: 'button', name: '填写连接凭据' },
        ]
      : [];
const reads: string[] = [];
const writes: string[] = [];
const unexpectedReads: string[] = [];
let mounted = false;
function publish() {
  Reflect.set(window, '__focusCapture', {
    ready:
      mounted &&
      (requiredReads[caseName] ?? []).every((path) => reads.includes(path)),
    case: caseName,
    controls: controls[caseName] ?? [],
    actions,
    reads: [...reads],
    writes: [...writes],
    unexpectedReads: [...unexpectedReads],
    context:
      'Real non-chatflow components; fixed synthetic reads; no submit or live backend.',
  });
}
publish();
document.addEventListener(
  'submit',
  (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  },
  true,
);
window.fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input), location.href);
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) {
    writes.push(`${method} ${url.pathname}`);
    publish();
    return Response.json(
      { error: 'Preview blocks all writes' },
      { status: 405 },
    );
  }
  let body: unknown;
  if (url.origin !== location.origin) body = undefined;
  else if (url.pathname === `/api/v1/admin/organizations/${company.id}/people`)
    body = { people, nextCursor: null };
  else if (
    url.pathname === `/api/v1/admin/organizations/${company.id}/departments`
  )
    body = { departments, nextCursor: null };
  else if (
    url.pathname === `/api/v1/admin/organizations/${company.id}/ai-directory`
  )
    body = directory;
  else if (url.pathname === '/api/v1/admin/platform-employees')
    body = {
      employees: [employee],
      skills: [],
      workspaces: [],
      tools: [],
      rapidIteration: true,
    };
  else if (url.pathname === '/api/v1/connections')
    body = { connections: [connection] };
  if (body === undefined) {
    unexpectedReads.push(url.href);
    publish();
    return Response.json(
      { error: 'Read not declared by preview fixture' },
      { status: 404 },
    );
  }
  reads.push(url.pathname);
  requestAnimationFrame(() => requestAnimationFrame(publish));
  return Response.json(body);
};
function Fixture() {
  useEffect(() => {
    mounted = true;
    requestAnimationFrame(() => requestAnimationFrame(publish));
  }, []);
  let content: ReactNode;
  if (caseName === 'organization' || caseName === 'organization-form')
    content = (
      <OrganizationPeople
        organization={company}
        onBusy={noop}
        onChanged={noop}
      />
    );
  else if (caseName === 'employees') content = <EmployeeProduction />;
  else if (caseName === 'directory')
    content = <OrganizationAiDirectory organizationId={company.id} />;
  else if (caseName === 'login')
    content = (
      <main
        className="auth-shell auth-workspace"
        style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}
      >
        <section className="auth-form-panel">
          <div className="auth-panel">
            <h1>登录工作台</h1>
            <LoginForm />
          </div>
        </section>
      </main>
    );
  else if (caseName === 'mcp') content = <ConnectedApps workspaceId={id(2)} />;
  else throw Error(`Unknown preview case: ${caseName}`);
  return (
    <>
      <FocusController />
      <div
        className={caseName === 'login' ? undefined : admin.theme}
        style={
          caseName === 'login'
            ? undefined
            : { minHeight: '100dvh', padding: 20 }
        }
        data-admin-field-preview={caseName}
      >
        {content}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
