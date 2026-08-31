'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AppSidebar } from '../components/app-sidebar';
import { useAppShell } from '../components/app-shell';

type Tab = 'persona' | 'skills' | 'model' | 'security';
type Capability =
  | 'network:outbound'
  | 'storage:read'
  | 'storage:write'
  | 'secret:use'
  | 'model:invoke'
  | 'automation:write';
type DataScope = 'organization' | 'workspace' | 'employee' | 'user';
type ConnectorMode = 'user' | 'service';
type Approval = 'confirm_side_effects' | 'confirm_external' | 'autonomous';

interface PartnerProfile {
  role: string;
  mission: string;
  communicationStyle: 'concise' | 'structured' | 'exploratory';
  outputLanguage: 'zh-CN' | 'en-US';
  proactivePolicy: 'suggest' | 'ask' | 'disabled';
  approvalPolicy: Approval;
}

interface EmployeeDefinition {
  schemaVersion: 1 | 2;
  name: string;
  description: string;
  applicableScenarios?: string[];
  identity?: {
    role: string;
    mission: string;
    workStyle: string;
    behaviorRules: string[];
    safetyBoundaries: string[];
  };
  runtimePolicy?: {
    harness: 'codex' | 'dsh';
    provider: string;
    model: string;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    timeoutMs: number;
    fallbackModels: string[];
    credentialReference?: string;
    baseUrl?: string | null;
  };
  provider: {
    provider: string;
    model: string;
    reasoningEffort: string;
  };
  capabilities: Capability[];
  capabilityBindings?: {
    toolNames: string[];
  };
  securityPolicy?: {
    dataScopes: DataScope[];
    connectorIdentityModes: ConnectorMode[];
    approvalPolicy: Approval;
    deniedCapabilities: Capability[];
  };
  userProfilePolicy?: {
    enabled: boolean;
    fields: ('displayName' | 'preferences')[];
    scope: 'employee_user';
  };
  partnerProfile: PartnerProfile;
}

interface Version {
  id: string;
  version: number;
  manifest: EmployeeDefinition;
  publishedAt: string;
}

interface DirectoryEntry {
  employeeId: string;
  employeeKey: string;
  status: 'active' | 'archived';
  currentVersion: Version;
  assignedUserIds: string[];
}

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member' | 'viewer';
}

interface Assignment {
  id: string;
  employeeId: string;
  employeeKey: string;
  isDefault: boolean;
  currentVersion: Version;
}

interface Hub {
  organizationId: string;
  workspaceId: string;
  canAdminister: boolean;
  assignments: Assignment[];
  directory: DirectoryEntry[];
  members: Member[];
}

interface CatalogRevision {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'deprecated' | 'revoked';
}

interface CapabilityCatalog {
  agentSkills: {
    installationId: string;
    grantedCapabilities: Capability[];
    revision: CatalogRevision & {
      metadata: {
        applicableScenarios: string[];
        requiredToolRefs: string[];
        riskLevel: 'low' | 'medium' | 'high' | 'critical';
      };
    };
  }[];
  workflows: (CatalogRevision & { workflowId: string })[];
  knowledge: (CatalogRevision & { knowledgeSourceId: string })[];
}

interface EmployeeCapabilities {
  employeeId: string;
  agentSkills: {
    installationId: string;
    grantedCapabilities: Capability[];
    revision: CatalogRevision;
    effective: boolean;
    disabledReason: string | null;
  }[];
  workflows: {
    revision: CatalogRevision;
    effective: boolean;
    disabledReason: string | null;
  }[];
  knowledge: {
    revision: CatalogRevision;
    effective: boolean;
    disabledReason: string | null;
  }[];
}

interface WorkflowRunSummary {
  id: string;
  runId: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_approval'
    | 'succeeded'
    | 'failed'
    | 'canceled'
    | 'needs_attention';
  currentStepKey: string | null;
  createdAt: string;
  completedAt: string | null;
  steps: {
    stepKey: string;
    name: string;
    status: string;
    attempt: number;
  }[];
}

interface Draft {
  partnerProfile: PartnerProfile;
  applicableScenarios: string[];
  identity: NonNullable<EmployeeDefinition['identity']>;
  runtimePolicy: NonNullable<EmployeeDefinition['runtimePolicy']>;
  securityPolicy: NonNullable<EmployeeDefinition['securityPolicy']>;
  userProfilePolicy: NonNullable<EmployeeDefinition['userProfilePolicy']>;
  toolNames: string[];
}

const tabs: { id: Tab; label: string; hint: string }[] = [
  { id: 'persona', label: '人设', hint: '身份、工作方式与用户档案' },
  { id: 'skills', label: '技能', hint: 'Skill、Workflow、Knowledge 与工具' },
  { id: 'model', label: '模型', hint: 'Harness、模型与运行策略' },
  { id: 'security', label: '安全', hint: '权限、数据范围与审批策略' },
];

const capabilityLabels: Record<Capability, string> = {
  'model:invoke': '调用模型',
  'storage:read': '读取工作区数据',
  'storage:write': '写入工作区数据',
  'network:outbound': '访问公开网络',
  'automation:write': '创建自动化',
  'secret:use': '使用连接器凭证',
};

const toolLabels: Record<string, string> = {
  'workspace.file.list': '列出工作区文件',
  'workspace.file.read': '读取工作区文件',
  'workspace.memory.search': '检索工作记忆',
  'workspace.session.search': '检索历史对话',
  'local.fs.list': '列出本地授权文件',
  'local.fs.search': '搜索本地授权文件',
  'local.fs.read': '读取本地授权文件',
  'local.git.status': '查看本地 Git 状态',
  'local.git.diff': '读取本地 Git 差异',
  'automation.create': '创建自动化任务',
};

const defaultProfile: PartnerProfile = {
  role: '通用工作伙伴',
  mission: '理解目标、推进任务，并交付可继续协作的结果。',
  communicationStyle: 'structured',
  outputLanguage: 'zh-CN',
  proactivePolicy: 'suggest',
  approvalPolicy: 'confirm_side_effects',
};

const managedMinimaxRuntime = {
  harness: 'dsh' as const,
  provider: 'openai-compatible',
  model: 'MiniMax-M3',
  reasoningEffort: 'high' as const,
  credentialReference: 'deployment:minimax-default',
  baseUrl: 'https://api.minimaxi.com/v1',
};

const managedCodexRuntime = {
  harness: 'dsh' as const,
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'xhigh' as const,
  credentialReference: 'deployment:codex-default',
  baseUrl: null,
};

const managedDeepseekRuntime = {
  harness: 'dsh' as const,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high' as const,
  credentialReference: 'deployment:deepseek-default',
  baseUrl: null,
};

function lines(value: string) {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function disabledCapabilityLabel(reason: string | null) {
  return (
    {
      installation_disabled: '工作区安装已停用',
      revision_unavailable: '能力已下架或归档',
      source_unavailable: '技能来源不可用',
      acl_denied: '当前成员无数据权限',
      binding_disabled: '绑定已停用',
    }[reason ?? ''] ?? '当前不可用'
  );
}

function createDraft(manifest: EmployeeDefinition): Draft {
  const profile = manifest.partnerProfile ?? defaultProfile;
  return {
    partnerProfile: profile,
    applicableScenarios: manifest.applicableScenarios ?? [],
    identity: manifest.identity ?? {
      role: profile.role,
      mission: profile.mission,
      workStyle: '先理解目标，再结构化推进并交付可复用结果。',
      behaviorRules: [],
      safetyBoundaries: [],
    },
    runtimePolicy: manifest.runtimePolicy
      ? {
          ...manifest.runtimePolicy,
          harness: 'dsh',
          provider:
            manifest.runtimePolicy.harness === 'codex' ||
            manifest.runtimePolicy.provider === 'codex'
              ? 'openai-codex'
              : manifest.runtimePolicy.provider,
        }
      : {
          ...managedCodexRuntime,
          timeoutMs: 300_000,
          fallbackModels: [],
        },
    securityPolicy: manifest.securityPolicy ?? {
      dataScopes: ['workspace', 'employee', 'user'],
      connectorIdentityModes: ['user'],
      approvalPolicy: profile.approvalPolicy,
      deniedCapabilities: ['secret:use'],
    },
    userProfilePolicy: manifest.userProfilePolicy ?? {
      enabled: true,
      fields: ['displayName', 'preferences'],
      scope: 'employee_user',
    },
    toolNames: manifest.capabilityBindings?.toolNames ?? [],
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('登录状态已失效');
  }
  const body = (await response.json().catch(() => null)) as
    T | { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

function ToggleList<T extends string>({
  values,
  selected,
  labels,
  disabled,
  onChange,
}: {
  values: readonly T[];
  selected: T[];
  labels: Record<T, string>;
  disabled?: boolean;
  onChange: (next: T[]) => void;
}) {
  return (
    <div className="employee-toggle-grid">
      {values.map((value) => (
        <label className="employee-toggle" key={value}>
          <input
            type="checkbox"
            checked={selected.includes(value)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...new Set([...selected, value])]
                  : selected.filter((item) => item !== value),
              )
            }
          />
          <span>{labels[value]}</span>
        </label>
      ))}
    </div>
  );
}

export function EmployeeHubClient({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const appShell = useAppShell();
  const [hub, setHub] = useState<Hub | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('persona');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [bindings, setBindings] = useState<EmployeeCapabilities | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () => hub?.directory.find((item) => item.employeeId === selectedEmployeeId),
    [hub, selectedEmployeeId],
  );
  const headers = useMemo(
    () => ({
      'content-type': 'application/json',
      'x-allrice-organization-id': hub?.organizationId ?? '',
      'x-allrice-workspace-id': hub?.workspaceId ?? '',
    }),
    [hub],
  );

  const load = useCallback(async () => {
    const result = await readJson<{ employeeHub: Hub }>(
      await fetch('/api/v1/employees', { cache: 'no-store' }),
    );
    setHub(result.employeeHub);
    setSelectedEmployeeId((current) =>
      result.employeeHub.directory.some((item) => item.employeeId === current)
        ? current
        : (result.employeeHub.directory[0]?.employeeId ?? ''),
    );
  }, []);

  const loadCapabilities = useCallback(
    async (employeeId: string, currentHub: Hub) => {
      const requestHeaders = {
        'x-allrice-organization-id': currentHub.organizationId,
        'x-allrice-workspace-id': currentHub.workspaceId,
      };
      const [catalogResult, bindingResult, workflowResult] = await Promise.all([
        readJson<{ catalog: CapabilityCatalog }>(
          await fetch(
            `/api/v1/admin/capabilities?workspaceId=${currentHub.workspaceId}`,
            { cache: 'no-store', headers: requestHeaders },
          ),
        ),
        readJson<{ capabilities: EmployeeCapabilities }>(
          await fetch(
            `/api/v1/employees/${employeeId}/capabilities?workspaceId=${currentHub.workspaceId}`,
            { cache: 'no-store', headers: requestHeaders },
          ),
        ),
        readJson<{ workflowRuns: WorkflowRunSummary[] }>(
          await fetch(
            `/api/v1/workflow-runs?workspaceId=${currentHub.workspaceId}&employeeId=${employeeId}&limit=8`,
            { cache: 'no-store', headers: requestHeaders },
          ),
        ),
      ]);
      setCatalog(catalogResult.catalog);
      setBindings(bindingResult.capabilities);
      setSelectedSkills(
        bindingResult.capabilities.agentSkills.map((item) => item.revision.id),
      );
      setSelectedWorkflows(
        bindingResult.capabilities.workflows.map((item) => item.revision.id),
      );
      setSelectedKnowledge(
        bindingResult.capabilities.knowledge.map((item) => item.revision.id),
      );
      setWorkflowRuns(workflowResult.workflowRuns);
    },
    [],
  );

  useEffect(() => {
    load().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '加载失败'),
    );
  }, [load]);

  useEffect(() => {
    if (!selected || !hub) return;
    setDraft(createDraft(selected.currentVersion.manifest));
    setError('');
    setNotice('');
    void loadCapabilities(selected.employeeId, hub).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '能力配置加载失败'),
    );
  }, [hub, loadCapabilities, selected]);

  async function saveDefinition(message: string) {
    if (!hub || !selected || !draft) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await readJson(
        await fetch('/api/v1/employees', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            employeeId: selected.employeeId,
            applicableScenarios: draft.applicableScenarios,
            identity: draft.identity,
            runtimePolicy: draft.runtimePolicy,
            securityPolicy: draft.securityPolicy,
            userProfilePolicy: draft.userProfilePolicy,
            toolNames: draft.toolNames,
            partnerProfile: {
              ...draft.partnerProfile,
              role: draft.identity.role,
              mission: draft.identity.mission,
              approvalPolicy: draft.securityPolicy.approvalPolicy,
            },
          }),
        }),
      );
      await load();
      setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveCapabilityBindings() {
    if (!hub || !selected || !catalog) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await readJson<{ capabilities: EmployeeCapabilities }>(
        await fetch(`/api/v1/employees/${selected.employeeId}/capabilities`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            agentSkills: catalog.agentSkills
              .filter((item) => selectedSkills.includes(item.revision.id))
              .map((item) => ({
                installationId: item.installationId,
                skillVersionId: item.revision.id,
                grantedCapabilities: item.grantedCapabilities,
              })),
            workflowRevisionIds: selectedWorkflows,
            knowledgeRevisionIds: selectedKnowledge,
          }),
        }),
      );
      setBindings(result.capabilities);
      setNotice('能力绑定已保存，只影响后续新任务。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '能力绑定保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function setAssigned(userId: string, assigned: boolean) {
    if (!hub || !selected) return;
    const userIds = assigned
      ? [...new Set([...selected.assignedUserIds, userId])]
      : selected.assignedUserIds.filter((id) => id !== userId);
    setBusy(true);
    setError('');
    try {
      const result = await readJson<{ employeeHub: Hub }>(
        await fetch(`/api/v1/employees/${selected.employeeId}/assignments`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ workspaceId: hub.workspaceId, userIds }),
        }),
      );
      setHub(result.employeeHub);
      setNotice('成员分配已更新。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '分配失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    if (!hub || !selected) return;
    setBusy(true);
    setError('');
    try {
      await readJson(
        await fetch(`/api/v1/employees/${selected.employeeId}/status`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            status: selected.status === 'active' ? 'archived' : 'active',
          }),
        }),
      );
      await load();
      setNotice('员工状态已更新。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态更新失败');
    } finally {
      setBusy(false);
    }
  }

  if (!hub) {
    return (
      <main className="workspace-loading">{error || '正在加载 AI员工…'}</main>
    );
  }

  const disabled = busy || selected?.status !== 'active';
  const unavailableSkills =
    bindings?.agentSkills.filter((binding) => !binding.effective) ?? [];
  const unavailableWorkflows =
    bindings?.workflows.filter((binding) => !binding.effective) ?? [];
  const unavailableKnowledge =
    bindings?.knowledge.filter((binding) => !binding.effective) ?? [];
  const content = !hub.canAdminister ? (
    <div className="employee-surface-shell employeehub-shell">
      <header className="employee-surface-header">
        <div>
          <p className="eyebrow">ALLRICE · AI EMPLOYEES</p>
          <h1>AI员工由管理员配置</h1>
          <p className="lede">
            你只需使用已分配的员工，内部模型、能力与权限不会暴露给普通用户。
          </p>
        </div>
        {appShell ? (
          <button
            className="primary-action"
            type="button"
            onClick={() => appShell.navigate('workspace')}
          >
            返回与 Rice 工作
          </button>
        ) : (
          <Link className="primary-action" href="/chatflow">
            返回与 Rice 工作
          </Link>
        )}
      </header>
    </div>
  ) : (
    <div className="employee-surface-shell employeehub-shell independent-employee-shell">
      <header className="employee-surface-header employee-admin-header">
        <div>
          <p className="eyebrow">ALLRICE · EMPLOYEE ADMIN</p>
          <h1>AI员工配置中心</h1>
          <p className="lede">
            配置定制员工的人设、能力、模型和安全边界；普通用户只负责使用。
          </p>
        </div>
      </header>

      <section className="employee-directory">
        <div className="partner-section-heading">
          <div>
            <p className="eyebrow">员工目录</p>
            <h2>选择要配置的员工</h2>
          </div>
          <span>{hub.directory.length} 位员工</span>
        </div>
        <div className="employee-directory-grid">
          {hub.directory.map((employee) => (
            <button
              className={
                employee.employeeId === selectedEmployeeId
                  ? 'employee-directory-card employee-directory-card-active'
                  : 'employee-directory-card'
              }
              key={employee.employeeId}
              onClick={() => setSelectedEmployeeId(employee.employeeId)}
              type="button"
            >
              <span className="employee-directory-avatar">✦</span>
              <span>
                <strong>{employee.currentVersion.manifest.name}</strong>
                <small>
                  {employee.currentVersion.manifest.partnerProfile.role}
                </small>
              </span>
              <em>{employee.status === 'active' ? '启用' : '停用'}</em>
            </button>
          ))}
        </div>
      </section>

      {selected && draft ? (
        <section className="employee-detail-panel employee-admin-detail">
          <div className="employee-detail-heading">
            <div className="employee-identity">
              <div className="rice-avatar">✦</div>
              <div>
                <p className="eyebrow">
                  {selected.employeeKey === 'default-assistant'
                    ? '系统内置 · 默认通用员工'
                    : '定制交付 · 管理员配置'}
                </p>
                <h2>{selected.currentVersion.manifest.name}</h2>
                <p>{selected.currentVersion.manifest.description}</p>
                <div className="employee-config-meta">
                  <span>
                    {selected.status === 'active' ? '已启用' : '已停用'}
                  </span>
                  <span>
                    最近更新{' '}
                    {new Date(
                      selected.currentVersion.publishedAt,
                    ).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              disabled={busy || selected.employeeKey === 'default-assistant'}
              onClick={() => void toggleStatus()}
            >
              {selected.status === 'active' ? '停用员工' : '重新启用'}
            </button>
          </div>

          <div
            className="employee-admin-tabs"
            role="tablist"
            aria-label="员工配置分类"
          >
            {tabs.map((tab) => (
              <button
                id={`employee-tab-${tab.id}`}
                aria-controls={`employee-panel-${tab.id}`}
                aria-selected={activeTab === tab.id}
                className={
                  activeTab === tab.id ? 'employee-admin-tab-active' : ''
                }
                key={tab.id}
                role="tab"
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                <strong>{tab.label}</strong>
                <span>{tab.hint}</span>
              </button>
            ))}
          </div>

          <div
            id={`employee-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`employee-tab-${activeTab}`}
          >
            {activeTab === 'persona' ? (
              <div className="employee-admin-panel-grid">
                <div className="employee-config-column">
                  <div className="employee-config-section-heading">
                    <div>
                      <p className="eyebrow">伙伴档案</p>
                      <h3>身份与工作方式</h3>
                    </div>
                    <span>管理员配置</span>
                  </div>
                  <label>
                    角色
                    <input
                      disabled={disabled}
                      value={draft.identity.role}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                identity: {
                                  ...current.identity,
                                  role: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    使命
                    <textarea
                      disabled={disabled}
                      value={draft.identity.mission}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                identity: {
                                  ...current.identity,
                                  mission: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    工作风格
                    <textarea
                      disabled={disabled}
                      value={draft.identity.workStyle}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                identity: {
                                  ...current.identity,
                                  workStyle: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    适用场景
                    <textarea
                      disabled={disabled}
                      value={draft.applicableScenarios.join('\n')}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                applicableScenarios: lines(event.target.value),
                              }
                            : current,
                        )
                      }
                    />
                    <small className="field-help">每行一个场景。</small>
                  </label>
                  <label>
                    行为准则
                    <textarea
                      disabled={disabled}
                      value={draft.identity.behaviorRules.join('\n')}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                identity: {
                                  ...current.identity,
                                  behaviorRules: lines(event.target.value),
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    安全边界
                    <textarea
                      disabled={disabled}
                      value={draft.identity.safetyBoundaries.join('\n')}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                identity: {
                                  ...current.identity,
                                  safetyBoundaries: lines(event.target.value),
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <div className="employee-inline-fields">
                    <label>
                      表达方式
                      <select
                        disabled={disabled}
                        value={draft.partnerProfile.communicationStyle}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  partnerProfile: {
                                    ...current.partnerProfile,
                                    communicationStyle: event.target
                                      .value as PartnerProfile['communicationStyle'],
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="structured">结构清晰</option>
                        <option value="concise">结论优先</option>
                        <option value="exploratory">展开比较</option>
                      </select>
                    </label>
                    <label>
                      默认语言
                      <select
                        disabled={disabled}
                        value={draft.partnerProfile.outputLanguage}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  partnerProfile: {
                                    ...current.partnerProfile,
                                    outputLanguage: event.target
                                      .value as PartnerProfile['outputLanguage'],
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="zh-CN">简体中文</option>
                        <option value="en-US">English</option>
                      </select>
                    </label>
                    <label>
                      主动性
                      <select
                        disabled={disabled}
                        value={draft.partnerProfile.proactivePolicy}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  partnerProfile: {
                                    ...current.partnerProfile,
                                    proactivePolicy: event.target
                                      .value as PartnerProfile['proactivePolicy'],
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="suggest">建议下一步</option>
                        <option value="ask">先询问</option>
                        <option value="disabled">不主动建议</option>
                      </select>
                    </label>
                  </div>
                  <button
                    className="primary-action"
                    disabled={disabled}
                    type="button"
                    onClick={() =>
                      void saveDefinition('人设配置已保存，只影响后续新任务。')
                    }
                  >
                    保存人设
                  </button>
                </div>

                <div className="employee-side-stack">
                  <section className="employee-config-card">
                    <div className="employee-config-section-heading">
                      <div>
                        <p className="eyebrow">用户档案</p>
                        <h3>按员工隔离注入</h3>
                      </div>
                      <span>私有</span>
                    </div>
                    <label className="employee-toggle">
                      <input
                        type="checkbox"
                        disabled={disabled}
                        checked={draft.userProfilePolicy.enabled}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  userProfilePolicy: {
                                    ...current.userProfilePolicy,
                                    enabled: event.target.checked,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                      <span>允许注入当前用户档案</span>
                    </label>
                    <ToggleList
                      values={['displayName', 'preferences'] as const}
                      selected={draft.userProfilePolicy.fields}
                      labels={{
                        displayName: '显示名称',
                        preferences: '个人偏好',
                      }}
                      disabled={disabled || !draft.userProfilePolicy.enabled}
                      onChange={(fields) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                userProfilePolicy: {
                                  ...current.userProfilePolicy,
                                  fields,
                                },
                              }
                            : current,
                        )
                      }
                    />
                    <p className="muted">
                      档案按“员工 × 用户”隔离，不会分享给其他成员或员工。
                    </p>
                  </section>
                  <section className="employee-config-card">
                    <div className="employee-memory-heading">
                      <div>
                        <h3>分配给成员</h3>
                        <p>被分配后，员工才会出现在其工作台。</p>
                      </div>
                      <strong>{selected.assignedUserIds.length}</strong>
                    </div>
                    {selected.employeeKey === 'default-assistant' ? (
                      <p className="muted">Rice 自动提供给工作区所有成员。</p>
                    ) : (
                      <div className="employee-memory-list">
                        {hub.members.map((member) => (
                          <label className="skill-choice" key={member.userId}>
                            <input
                              type="checkbox"
                              checked={selected.assignedUserIds.includes(
                                member.userId,
                              )}
                              disabled={disabled}
                              onChange={(event) =>
                                void setAssigned(
                                  member.userId,
                                  event.target.checked,
                                )
                              }
                            />
                            <span>
                              {member.displayName || member.email}
                              <small>{member.email}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            ) : null}

            {activeTab === 'skills' ? (
              <div className="employee-capability-sections">
                <section className="employee-config-card employee-capability-card">
                  <div className="employee-config-section-heading">
                    <div>
                      <p className="eyebrow">Agent Skill</p>
                      <h3>可复用专业能力</h3>
                    </div>
                    <span>{selectedSkills.length} 项</span>
                  </div>
                  <div className="employee-capability-list">
                    {catalog?.agentSkills.map((item) => (
                      <label
                        key={item.revision.id}
                        className="employee-capability-row"
                      >
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={selectedSkills.includes(item.revision.id)}
                          onChange={(event) =>
                            setSelectedSkills((current) =>
                              event.target.checked
                                ? [...new Set([...current, item.revision.id])]
                                : current.filter(
                                    (id) => id !== item.revision.id,
                                  ),
                            )
                          }
                        />
                        <span>
                          <strong>{item.revision.name}</strong>
                          <small>{item.revision.description}</small>
                          <em>
                            {item.revision.metadata.riskLevel === 'low'
                              ? '低风险'
                              : item.revision.metadata.riskLevel === 'medium'
                                ? '中风险'
                                : '需谨慎授权'}
                          </em>
                        </span>
                      </label>
                    ))}
                  </div>
                  {!catalog?.agentSkills.length ? (
                    <p className="muted">暂未为该员工装配 DSH 原生 Skill。</p>
                  ) : null}
                  {unavailableSkills.map((binding) => (
                    <div
                      className="employee-unavailable-binding"
                      key={binding.revision.id}
                    >
                      <span>
                        <strong>{binding.revision.name}</strong>
                        <small>
                          {disabledCapabilityLabel(binding.disabledReason)}
                        </small>
                      </span>
                      <em>下次保存自动清理</em>
                    </div>
                  ))}
                </section>
                <section className="employee-config-card employee-capability-card">
                  <div className="employee-config-section-heading">
                    <div>
                      <p className="eyebrow">Workflow</p>
                      <h3>稳定工作流程</h3>
                    </div>
                    <span>{selectedWorkflows.length} 项</span>
                  </div>
                  <div className="employee-capability-list">
                    {catalog?.workflows.map((item) => (
                      <label key={item.id} className="employee-capability-row">
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={selectedWorkflows.includes(item.id)}
                          onChange={(event) =>
                            setSelectedWorkflows((current) =>
                              event.target.checked
                                ? [...new Set([...current, item.id])]
                                : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {!catalog?.workflows.length ? (
                    <p className="muted">当前工作区还没有可绑定的 Workflow。</p>
                  ) : null}
                  {unavailableWorkflows.map((binding) => (
                    <div
                      className="employee-unavailable-binding"
                      key={binding.revision.id}
                    >
                      <span>
                        <strong>{binding.revision.name}</strong>
                        <small>
                          {disabledCapabilityLabel(binding.disabledReason)}
                        </small>
                      </span>
                      <em>下次保存自动清理</em>
                    </div>
                  ))}
                </section>
                <section className="employee-config-card employee-capability-card">
                  <div className="employee-config-section-heading">
                    <div>
                      <p className="eyebrow">Knowledge</p>
                      <h3>授权知识来源</h3>
                    </div>
                    <span>{selectedKnowledge.length} 项</span>
                  </div>
                  <div className="employee-capability-list">
                    {catalog?.knowledge.map((item) => (
                      <label key={item.id} className="employee-capability-row">
                        <input
                          type="checkbox"
                          disabled={disabled}
                          checked={selectedKnowledge.includes(item.id)}
                          onChange={(event) =>
                            setSelectedKnowledge((current) =>
                              event.target.checked
                                ? [...new Set([...current, item.id])]
                                : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {!catalog?.knowledge.length ? (
                    <p className="muted">
                      当前工作区还没有可绑定的 Knowledge。
                    </p>
                  ) : null}
                  {unavailableKnowledge.map((binding) => (
                    <div
                      className="employee-unavailable-binding"
                      key={binding.revision.id}
                    >
                      <span>
                        <strong>{binding.revision.name}</strong>
                        <small>
                          {disabledCapabilityLabel(binding.disabledReason)}
                        </small>
                      </span>
                      <em>下次保存自动清理</em>
                    </div>
                  ))}
                </section>
                <button
                  className="primary-action employee-save-capabilities"
                  disabled={disabled || !catalog || !bindings}
                  type="button"
                  onClick={() => void saveCapabilityBindings()}
                >
                  保存 Skill / Workflow / Knowledge
                </button>
                <div className="employee-capability-secondary-grid">
                  <section className="employee-config-card">
                    <div className="employee-config-section-heading">
                      <div>
                        <p className="eyebrow">Tool</p>
                        <h3>内置受控工具</h3>
                      </div>
                      <span>独立配置</span>
                    </div>
                    <ToggleList
                      values={Object.keys(toolLabels)}
                      selected={draft.toolNames}
                      labels={toolLabels}
                      disabled={disabled}
                      onChange={(toolNames) =>
                        setDraft((current) =>
                          current ? { ...current, toolNames } : current,
                        )
                      }
                    />
                    <button
                      disabled={disabled}
                      type="button"
                      onClick={() =>
                        void saveDefinition('内置工具配置已保存。')
                      }
                    >
                      保存工具配置
                    </button>
                  </section>
                  <section className="employee-config-card">
                    <div className="employee-config-section-heading">
                      <div>
                        <p className="eyebrow">Connector</p>
                        <h3>连接器身份</h3>
                      </div>
                      <span>安全策略</span>
                    </div>
                    <p>
                      连接器与 Skill 分开授权。当前允许：
                      {draft.securityPolicy.connectorIdentityModes
                        .map((mode) =>
                          mode === 'user' ? '用户身份' : '服务身份',
                        )
                        .join('、') || '无'}
                      。
                    </p>
                    <button
                      type="button"
                      onClick={() => setActiveTab('security')}
                    >
                      前往安全页配置
                    </button>
                  </section>
                </div>
              </div>
            ) : null}

            {activeTab === 'model' ? (
              <div className="employee-admin-panel-grid">
                <div className="employee-config-column">
                  <div className="employee-config-section-heading">
                    <div>
                      <p className="eyebrow">Runtime</p>
                      <h3>模型与运行策略</h3>
                    </div>
                    <span>管理员配置</span>
                  </div>
                  <div className="employee-inline-fields">
                    <label>
                      执行引擎
                      <input disabled value="DSH Harness" />
                    </label>
                    <label>
                      Provider
                      <select
                        disabled={disabled}
                        value={draft.runtimePolicy.provider}
                        onChange={(event) =>
                          setDraft((current) => {
                            if (!current) return current;
                            const provider = event.target.value;
                            return {
                              ...current,
                              runtimePolicy: {
                                ...current.runtimePolicy,
                                ...(provider === 'openai-codex'
                                  ? managedCodexRuntime
                                  : provider === 'openai-compatible'
                                    ? managedMinimaxRuntime
                                    : managedDeepseekRuntime),
                              },
                            };
                          })
                        }
                      >
                        <option value="openai-codex">
                          Codex 订阅（DSH Provider）
                        </option>
                        <option value="deepseek-official">
                          DeepSeek 官方 API
                        </option>
                        <option value="openai-compatible">
                          MiniMax（平台托管）
                        </option>
                      </select>
                    </label>
                  </div>
                  <div className="employee-config-card employee-runtime-note">
                    <p className="eyebrow">平台托管凭据</p>
                    <h3>已由 AllRice 服务端配置</h3>
                    <p>
                      管理员无需填写 API Key 或 Base URL；凭据只会在执行时注入
                      DSH Worker，不会进入员工配置、任务快照或浏览器。
                    </p>
                  </div>
                  <label>
                    模型
                    <input
                      disabled={disabled}
                      value={draft.runtimePolicy.model}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                runtimePolicy: {
                                  ...current.runtimePolicy,
                                  model: event.target.value,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <div className="employee-inline-fields">
                    <label>
                      推理强度
                      <select
                        disabled={disabled}
                        value={draft.runtimePolicy.reasoningEffort}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  runtimePolicy: {
                                    ...current.runtimePolicy,
                                    reasoningEffort: event.target
                                      .value as Draft['runtimePolicy']['reasoningEffort'],
                                  },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="none">Off</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">XHigh</option>
                      </select>
                    </label>
                    <label>
                      任务超时（秒）
                      <input
                        type="number"
                        min={1}
                        max={3600}
                        disabled={disabled}
                        value={Math.round(draft.runtimePolicy.timeoutMs / 1000)}
                        onChange={(event) =>
                          setDraft((current) =>
                            current
                              ? {
                                  ...current,
                                  runtimePolicy: {
                                    ...current.runtimePolicy,
                                    timeoutMs:
                                      Number(event.target.value) * 1000,
                                  },
                                }
                              : current,
                          )
                        }
                      />
                    </label>
                  </div>
                  <label>
                    降级模型
                    <textarea
                      disabled={disabled}
                      placeholder="每行一个模型；留空表示不降级"
                      value={draft.runtimePolicy.fallbackModels.join('\n')}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                runtimePolicy: {
                                  ...current.runtimePolicy,
                                  fallbackModels: lines(event.target.value),
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </label>
                  <button
                    className="primary-action"
                    disabled={disabled}
                    type="button"
                    onClick={() =>
                      void saveDefinition('模型配置已保存，只影响后续新任务。')
                    }
                  >
                    保存模型配置
                  </button>
                </div>
                <section className="employee-config-card employee-runtime-note">
                  <p className="eyebrow">当前执行内核</p>
                  <h3>DSH Harness</h3>
                  <p>
                    会话、工具调用、权限快照和执行证据由 AllRice
                    管理；普通用户不会直接选择底层模型。
                  </p>
                  <dl>
                    <div>
                      <dt>授权方式</dt>
                      <dd>
                        {draft.runtimePolicy.provider === 'openai-codex'
                          ? 'DSH managed ChatGPT subscription'
                          : 'AllRice credential binding'}
                      </dd>
                    </div>
                    <div>
                      <dt>沙箱</dt>
                      <dd>No host tools · Tool Broker only</dd>
                    </div>
                    <div>
                      <dt>配置来源</dt>
                      <dd>管理员员工定义</dd>
                    </div>
                  </dl>
                </section>
              </div>
            ) : null}

            {activeTab === 'security' ? (
              <div className="employee-admin-panel-grid">
                <div className="employee-config-column">
                  <div className="employee-config-section-heading">
                    <div>
                      <p className="eyebrow">Security</p>
                      <h3>有效权限与数据边界</h3>
                    </div>
                    <span>默认拒绝</span>
                  </div>
                  <fieldset>
                    <legend>允许的数据范围</legend>
                    <ToggleList
                      values={
                        [
                          'organization',
                          'workspace',
                          'employee',
                          'user',
                        ] as const
                      }
                      selected={draft.securityPolicy.dataScopes}
                      labels={{
                        organization: '组织',
                        workspace: '工作区',
                        employee: '当前员工',
                        user: '当前用户',
                      }}
                      disabled={disabled}
                      onChange={(dataScopes) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                securityPolicy: {
                                  ...current.securityPolicy,
                                  dataScopes,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </fieldset>
                  <fieldset>
                    <legend>连接器身份模式</legend>
                    <ToggleList
                      values={['user', 'service'] as const}
                      selected={draft.securityPolicy.connectorIdentityModes}
                      labels={{
                        user: '用户身份授权',
                        service: '工作区服务身份',
                      }}
                      disabled={disabled}
                      onChange={(connectorIdentityModes) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                securityPolicy: {
                                  ...current.securityPolicy,
                                  connectorIdentityModes,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </fieldset>
                  <label>
                    操作确认策略
                    <select
                      disabled={disabled}
                      value={draft.securityPolicy.approvalPolicy}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                securityPolicy: {
                                  ...current.securityPolicy,
                                  approvalPolicy: event.target
                                    .value as Approval,
                                },
                              }
                            : current,
                        )
                      }
                    >
                      <option value="confirm_side_effects">
                        所有修改前询问
                      </option>
                      <option value="confirm_external">对外操作前询问</option>
                      <option value="autonomous">已授权范围内自动执行</option>
                    </select>
                  </label>
                  <fieldset>
                    <legend>明确禁止的能力</legend>
                    <ToggleList
                      values={Object.keys(capabilityLabels) as Capability[]}
                      selected={draft.securityPolicy.deniedCapabilities}
                      labels={capabilityLabels}
                      disabled={disabled}
                      onChange={(deniedCapabilities) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                securityPolicy: {
                                  ...current.securityPolicy,
                                  deniedCapabilities,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  </fieldset>
                  <button
                    className="primary-action"
                    disabled={disabled}
                    type="button"
                    onClick={() =>
                      void saveDefinition('安全策略已保存，只影响后续新任务。')
                    }
                  >
                    保存安全策略
                  </button>
                </div>
                <section className="employee-config-card employee-effective-policy">
                  <p className="eyebrow">运行时交集</p>
                  <h3>最终权限如何得到</h3>
                  <p>
                    员工声明、成员授权、Skill grant、Knowledge
                    ACL、连接器授权与租户策略会在每次新任务开始时取交集，并固化进运行快照。
                  </p>
                  <div className="capability-list">
                    {selected.currentVersion.manifest.capabilities
                      .filter(
                        (capability) =>
                          !draft.securityPolicy.deniedCapabilities.includes(
                            capability,
                          ),
                      )
                      .map((capability) => (
                        <span key={capability}>
                          {capabilityLabels[capability]}
                        </span>
                      ))}
                  </div>
                  <p className="muted">
                    这里展示的是候选有效权限；实际任务仍可能因用户、数据或连接器未授权而收窄。
                  </p>
                </section>
              </div>
            ) : null}
          </div>
          <section className="employee-config-card employee-execution-history">
            <div className="employee-config-section-heading">
              <div>
                <p className="eyebrow">执行记录</p>
                <h3>最近 Workflow</h3>
              </div>
              <span>{workflowRuns.length} 条</span>
            </div>
            {workflowRuns.length ? (
              <div className="employee-execution-list">
                {workflowRuns.map((run) => (
                  <div className="employee-execution-row" key={run.id}>
                    <span>
                      <strong>
                        {run.currentStepKey
                          ? (run.steps.find(
                              (step) => step.stepKey === run.currentStepKey,
                            )?.name ?? run.currentStepKey)
                          : 'Workflow'}
                      </strong>
                      <small>
                        {
                          run.steps.filter(
                            (step) => step.status === 'succeeded',
                          ).length
                        }{' '}
                        / {run.steps.length} 个步骤 ·{' '}
                        {new Date(run.createdAt).toLocaleString()}
                      </small>
                    </span>
                    <em data-status={run.status}>
                      {
                        {
                          queued: '等待执行',
                          running: '执行中',
                          waiting_approval: '等待确认',
                          succeeded: '已完成',
                          failed: '失败',
                          canceled: '已取消',
                          needs_attention: '需要处理',
                        }[run.status]
                      }
                    </em>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">这个员工还没有 Workflow 执行记录。</p>
            )}
          </section>
          <div className="employee-save-feedback" aria-live="polite">
            {notice ? <p className="employee-notice">{notice}</p> : null}
            {error ? (
              <p className="surface-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );

  if (embedded) return <main className="employee-panel-only">{content}</main>;

  return (
    <main className="app-page-shell">
      <AppSidebar
        active="employees"
        action={
          <Link className="new-chat" href="/chatflow">
            ＋ 新建任务
          </Link>
        }
        className="app-page-sidebar"
        showEmployeeAdmin={hub.canAdminister}
      />
      <section className="app-page-content">{content}</section>
    </main>
  );
}
