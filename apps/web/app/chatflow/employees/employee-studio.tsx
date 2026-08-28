'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SaasCapabilityManifest } from '@allrice/contracts';

import styles from './employee-studio.module.css';

type Tab = 'persona' | 'capabilities' | 'model' | 'security' | 'members';
type Approval = 'confirm_side_effects' | 'confirm_external' | 'autonomous';

interface Definition {
  name: string;
  description: string;
  identity: {
    role: string;
    mission: string;
    workStyle: string;
    behaviorRules: string[];
    safetyBoundaries: string[];
  };
  runtimePolicy: {
    harness: 'dsh';
    provider: string;
    model: string;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
    timeoutMs: number;
    fallbackModels: string[];
    credentialReference?: string;
    baseUrl?: string | null;
  };
  securityPolicy: {
    dataScopes: ('organization' | 'workspace' | 'employee' | 'user')[];
    connectorIdentityModes: ('user' | 'service')[];
    approvalPolicy: Approval;
    deniedCapabilities: string[];
  };
  userProfilePolicy: {
    enabled: boolean;
    fields: ('displayName' | 'preferences')[];
    scope: 'employee_user';
  };
  partnerProfile: {
    role: string;
    mission: string;
    communicationStyle: 'concise' | 'structured' | 'exploratory';
    outputLanguage: 'zh-CN' | 'en-US';
    proactivePolicy: 'suggest' | 'ask' | 'disabled';
    approvalPolicy: Approval;
  };
  applicableScenarios: string[];
  capabilityBindings: { toolNames: string[] };
}

interface EmployeeVersion {
  id: string;
  version: number;
  manifest: Definition;
  publishedAt: string;
}

interface DirectoryEmployee {
  employeeId: string;
  employeeKey: string;
  status: 'active' | 'archived';
  currentVersion: EmployeeVersion;
  assignedUserIds: string[];
}

interface EmployeeAssignment {
  id: string;
  employeeId: string;
  employeeKey: string;
  isDefault: boolean;
  currentVersion: EmployeeVersion;
}

interface Hub {
  organizationId: string;
  workspaceId: string;
  canAdminister: boolean;
  directory: DirectoryEmployee[];
  assignments: EmployeeAssignment[];
  members: Array<{
    userId: string;
    email: string;
    displayName: string;
    role: 'admin' | 'member' | 'viewer';
  }>;
}

interface CatalogRevision {
  id: string;
  name: string;
  description: string;
  status: string;
}

interface Catalog {
  agentSkills: Array<{
    installationId: string;
    grantedCapabilities: string[];
    revision: CatalogRevision;
  }>;
  workflows: Array<CatalogRevision & { workflowId: string }>;
  knowledge: Array<CatalogRevision & { knowledgeSourceId: string }>;
}

interface Bindings {
  agentSkills: Array<{
    installationId: string;
    revision: CatalogRevision;
    grantedCapabilities: string[];
  }>;
  workflows: Array<{ revision: CatalogRevision }>;
  knowledge: Array<{ revision: CatalogRevision }>;
}

interface ModelPool {
  providers: Array<{ id: string; key: string; name: string }>;
  connections: Array<{
    id: string;
    providerId: string;
    name: string;
    status: 'ready' | 'degraded' | 'disabled';
  }>;
  models: Array<{
    id: string;
    providerId: string;
    displayName: string;
    reasoningEfforts: Array<'none' | 'low' | 'medium' | 'high' | 'xhigh'>;
    defaultReasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  }>;
}

interface ModelPolicy {
  connectionId: string;
  modelCatalogEntryId: string;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  fallbackPolicy: 'disabled' | 'explicit';
  fallbackTargets: Array<{
    connectionId: string;
    modelCatalogEntryId: string;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  }>;
  fallbackOn: Array<
    'provider_unavailable' | 'rate_limited' | 'timeout' | 'transient_error'
  >;
  runLimits: {
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxTotalTokens: number;
    maxCostCents: number | null;
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow/employees');
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

function splitLines(value: string) {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

const tabs: Array<{ id: Tab; label: string; note: string }> = [
  { id: 'persona', label: '人设', note: '身份、使命、行为规则' },
  { id: 'capabilities', label: '能力', note: 'Skill、Workflow、Knowledge' },
  { id: 'model', label: '模型', note: 'DSH Provider 与冻结策略' },
  { id: 'security', label: '安全', note: '范围、身份与审批' },
  { id: 'members', label: '成员', note: '员工使用范围' },
];

export function EmployeeStudio() {
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [hub, setHub] = useState<Hub | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [tab, setTab] = useState<Tab>('persona');
  const [draft, setDraft] = useState<Definition | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [bindings, setBindings] = useState<Bindings | null>(null);
  const [modelPool, setModelPool] = useState<ModelPool | null>(null);
  const [modelPolicy, setModelPolicy] = useState<ModelPolicy | null>(null);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>([]);
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const selected = useMemo(
    () => hub?.directory.find((item) => item.employeeId === selectedId),
    [hub, selectedId],
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
    const [hubResult, capabilityResult, modelPoolResult] = await Promise.all([
      readJson<{ employeeHub: Hub }>(
        await fetch('/api/v1/employees', { cache: 'no-store' }),
      ),
      readJson<{ capabilities: SaasCapabilityManifest }>(
        await fetch('/api/v1/saas/capabilities', { cache: 'no-store' }),
      ),
      readJson<{ modelPool: ModelPool }>(
        await fetch('/api/v1/model-pool', { cache: 'no-store' }),
      ),
    ]);
    setHub(hubResult.employeeHub);
    setManifest(capabilityResult.capabilities);
    setModelPool(modelPoolResult.modelPool);
    setSelectedId((current) =>
      hubResult.employeeHub.directory.some(
        (item) => item.employeeId === current,
      )
        ? current
        : (hubResult.employeeHub.directory[0]?.employeeId ?? ''),
    );
  }, []);

  const loadCapabilities = useCallback(
    async (employeeId: string, currentHub: Hub) => {
      const scopedHeaders = {
        'x-allrice-organization-id': currentHub.organizationId,
        'x-allrice-workspace-id': currentHub.workspaceId,
      };
      const [catalogResult, bindingResult, modelPolicyResult] =
        await Promise.all([
          readJson<{ catalog: Catalog }>(
            await fetch(
              `/api/v1/admin/capabilities?workspaceId=${currentHub.workspaceId}`,
              { cache: 'no-store', headers: scopedHeaders },
            ),
          ),
          readJson<{ capabilities: Bindings }>(
            await fetch(
              `/api/v1/employees/${employeeId}/capabilities?workspaceId=${currentHub.workspaceId}`,
              { cache: 'no-store', headers: scopedHeaders },
            ),
          ),
          readJson<{ policy: ModelPolicy | null }>(
            await fetch(
              `/api/v1/employees/${employeeId}/model-policy?workspaceId=${currentHub.workspaceId}`,
              { cache: 'no-store', headers: scopedHeaders },
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
      setModelPolicy(modelPolicyResult.policy);
    },
    [],
  );

  useEffect(() => {
    void load().catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : '员工加载失败'),
    );
  }, [load]);

  useEffect(() => {
    if (!selected || !hub) return;
    setDraft(structuredClone(selected.currentVersion.manifest));
    setSelectedMembers(selected.assignedUserIds);
    void loadCapabilities(selected.employeeId, hub).catch((error: unknown) =>
      setNotice(error instanceof Error ? error.message : '能力加载失败'),
    );
  }, [hub, loadCapabilities, selected]);

  function toggle(list: string[], value: string) {
    return list.includes(value)
      ? list.filter((item) => item !== value)
      : [...list, value];
  }

  async function saveDefinition() {
    if (!hub || !selected || !draft) return;
    setBusy(true);
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
            securityPolicy: draft.securityPolicy,
            userProfilePolicy: draft.userProfilePolicy,
            toolNames: draft.capabilityBindings.toolNames,
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
      setNotice('员工配置已发布；已有会话保持原快照，新会话使用新配置。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveCapabilities() {
    if (!hub || !selected || !catalog) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await readJson<{ capabilities: Bindings }>(
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
      setNotice('能力已绑定；只会在新任务的冻结快照中生效。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '能力保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveModelPolicy() {
    if (!hub || !selected || !modelPolicy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await readJson<{ policy: ModelPolicy }>(
        await fetch(
          `/api/v1/employees/${selected.employeeId}/model-policy?workspaceId=${hub.workspaceId}`,
          {
            method: 'PUT',
            headers,
            body: JSON.stringify(modelPolicy),
          },
        ),
      );
      setModelPolicy(result.policy);
      setNotice('模型策略已保存；新 Session 使用新快照，旧 Session 不变。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '模型策略保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveAssignments() {
    if (!hub || !selected || selected.employeeKey === 'default-assistant')
      return;
    setBusy(true);
    setNotice('');
    try {
      const result = await readJson<{ employeeHub: Hub }>(
        await fetch(`/api/v1/employees/${selected.employeeId}/assignments`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            workspaceId: hub.workspaceId,
            userIds: selectedMembers,
          }),
        }),
      );
      setHub(result.employeeHub);
      setNotice('员工使用范围已更新；未分配成员不会看到该员工。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '成员分配失败');
    } finally {
      setBusy(false);
    }
  }

  if (!hub || !manifest) {
    return <main className={styles.loading}>{notice || '正在加载员工…'}</main>;
  }

  if (!hub.canAdminister) {
    return (
      <main className={styles.memberPage}>
        <header>
          <Link href="/chatflow">← 返回与 Rice 工作</Link>
          <p>AI EMPLOYEES</p>
          <h1>可用员工</h1>
          <span>员工由管理员定制和分配，你可以直接选择并开始工作。</span>
        </header>
        <section className={styles.memberGrid}>
          {hub.assignments.map((assignment) => (
            <article key={assignment.id}>
              <i>{assignment.currentVersion.manifest.name.slice(0, 1)}</i>
              <h2>{assignment.currentVersion.manifest.name}</h2>
              <p>{assignment.currentVersion.manifest.description}</p>
              <span>{assignment.currentVersion.manifest.identity.role}</span>
              <Link href="/chatflow">开始工作</Link>
            </article>
          ))}
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.brand} href="/chatflow">
          <i>R</i>
          <span>
            <strong>AllRice</strong>
            <small>员工工作室</small>
          </span>
        </Link>
        <p>定制员工</p>
        <nav>
          {hub.directory.map((employee) => (
            <button
              className={
                employee.employeeId === selectedId ? styles.active : ''
              }
              key={employee.employeeId}
              onClick={() => setSelectedId(employee.employeeId)}
              type="button"
            >
              <i>{employee.currentVersion.manifest.name.slice(0, 1)}</i>
              <span>
                <strong>{employee.currentVersion.manifest.name}</strong>
                <small>{employee.currentVersion.manifest.identity.role}</small>
              </span>
            </button>
          ))}
        </nav>
        <footer>
          <Link href="/chatflow">对话</Link>
          <Link href="/chatflow/governance">评测与发布</Link>
          {manifest.surfaces.includes('platform_admin') ? (
            <Link href="/runtime-console?view=governance">平台管理</Link>
          ) : null}
        </footer>
      </aside>

      {selected && draft ? (
        <section className={styles.editor}>
          <header className={styles.topbar}>
            <div>
              <p>
                {selected.employeeKey === 'default-assistant'
                  ? '默认通用员工'
                  : '定制员工'}
              </p>
              <h1>{draft.name}</h1>
              <span>{draft.description}</span>
            </div>
            <button
              disabled={
                busy ||
                (tab === 'members' &&
                  selected.employeeKey === 'default-assistant')
              }
              onClick={() =>
                void (tab === 'capabilities'
                  ? saveCapabilities()
                  : tab === 'model'
                    ? saveModelPolicy()
                    : tab === 'members'
                      ? saveAssignments()
                      : saveDefinition())
              }
              type="button"
            >
              {busy ? '保存中…' : '保存配置'}
            </button>
          </header>

          <nav className={styles.tabs}>
            {tabs.map((item) => (
              <button
                className={tab === item.id ? styles.activeTab : ''}
                key={item.id}
                onClick={() => setTab(item.id)}
                type="button"
              >
                <strong>{item.label}</strong>
                <small>{item.note}</small>
              </button>
            ))}
          </nav>

          <div className={styles.canvas}>
            {tab === 'persona' ? (
              <div className={styles.formGrid}>
                <label>
                  角色
                  <input
                    value={draft.identity.role}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identity: {
                          ...draft.identity,
                          role: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  表达方式
                  <select
                    value={draft.partnerProfile.communicationStyle}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        partnerProfile: {
                          ...draft.partnerProfile,
                          communicationStyle: event.target
                            .value as Definition['partnerProfile']['communicationStyle'],
                        },
                      })
                    }
                  >
                    <option value="concise">简洁</option>
                    <option value="structured">结构化</option>
                    <option value="exploratory">探索式</option>
                  </select>
                </label>
                <label className={styles.wide}>
                  使命
                  <textarea
                    value={draft.identity.mission}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identity: {
                          ...draft.identity,
                          mission: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label className={styles.wide}>
                  工作方式
                  <textarea
                    value={draft.identity.workStyle}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identity: {
                          ...draft.identity,
                          workStyle: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label className={styles.wide}>
                  行为规则（每行一条）
                  <textarea
                    value={draft.identity.behaviorRules.join('\n')}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identity: {
                          ...draft.identity,
                          behaviorRules: splitLines(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
            ) : null}

            {tab === 'capabilities' ? (
              <div className={styles.capabilityColumns}>
                <CapabilityList
                  title="Agent Skill"
                  note="让员工知道如何完成某类工作"
                  items={
                    catalog?.agentSkills.map((item) => item.revision) ?? []
                  }
                  selected={selectedSkills}
                  onToggle={(id) =>
                    setSelectedSkills(toggle(selectedSkills, id))
                  }
                />
                <CapabilityList
                  title="Workflow"
                  note="可审计、可恢复的固定业务流程"
                  items={catalog?.workflows ?? []}
                  selected={selectedWorkflows}
                  onToggle={(id) =>
                    setSelectedWorkflows(toggle(selectedWorkflows, id))
                  }
                />
                <CapabilityList
                  title="Knowledge"
                  note="按租户权限检索的知识来源"
                  items={catalog?.knowledge ?? []}
                  selected={selectedKnowledge}
                  onToggle={(id) =>
                    setSelectedKnowledge(toggle(selectedKnowledge, id))
                  }
                />
                <div className={styles.bindingSummary}>
                  当前绑定 {bindings?.agentSkills.length ?? 0} 个 Skill、
                  {bindings?.workflows.length ?? 0} 个 Workflow、
                  {bindings?.knowledge.length ?? 0} 个 Knowledge。
                </div>
              </div>
            ) : null}

            {tab === 'model' && modelPool && modelPolicy ? (
              <div className={styles.modelPanel}>
                <div>
                  <span>平台连接</span>
                  <select
                    value={modelPolicy.connectionId}
                    onChange={(event) => {
                      const connection = modelPool.connections.find(
                        (item) => item.id === event.target.value,
                      );
                      const model = modelPool.models.find(
                        (item) => item.providerId === connection?.providerId,
                      );
                      if (!connection || !model) return;
                      setModelPolicy({
                        ...modelPolicy,
                        connectionId: connection.id,
                        modelCatalogEntryId: model.id,
                        reasoningEffort: model.defaultReasoningEffort,
                        fallbackPolicy: 'disabled',
                        fallbackTargets: [],
                      });
                    }}
                  >
                    {modelPool.connections.map((connection) => (
                      <option
                        disabled={connection.status !== 'ready'}
                        key={connection.id}
                        value={connection.id}
                      >
                        {
                          modelPool.providers.find(
                            (provider) => provider.id === connection.providerId,
                          )?.name
                        }{' '}
                        · {connection.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <span>模型</span>
                  <select
                    value={modelPolicy.modelCatalogEntryId}
                    onChange={(event) => {
                      const model = modelPool.models.find(
                        (item) => item.id === event.target.value,
                      );
                      if (!model) return;
                      setModelPolicy({
                        ...modelPolicy,
                        modelCatalogEntryId: model.id,
                        reasoningEffort: model.defaultReasoningEffort,
                      });
                    }}
                  >
                    {modelPool.models
                      .filter(
                        (model) =>
                          model.providerId ===
                          modelPool.connections.find(
                            (connection) =>
                              connection.id === modelPolicy.connectionId,
                          )?.providerId,
                      )
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <span>推理强度</span>
                  <select
                    value={modelPolicy.reasoningEffort}
                    onChange={(event) =>
                      setModelPolicy({
                        ...modelPolicy,
                        reasoningEffort: event.target
                          .value as ModelPolicy['reasoningEffort'],
                      })
                    }
                  >
                    {modelPool.models
                      .find(
                        (model) => model.id === modelPolicy.modelCatalogEntryId,
                      )
                      ?.reasoningEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort === 'xhigh' ? '极高' : effort}
                        </option>
                      ))}
                  </select>
                </div>
                <div>
                  <span>单次超时</span>
                  <input
                    min={1}
                    type="number"
                    value={Math.round(modelPolicy.runLimits.timeoutMs / 1000)}
                    onChange={(event) =>
                      setModelPolicy({
                        ...modelPolicy,
                        runLimits: {
                          ...modelPolicy.runLimits,
                          timeoutMs: Number(event.target.value) * 1000,
                        },
                      })
                    }
                  />
                </div>
                <p>
                  Session 创建时冻结 DSH
                  Provider、模型、降级白名单和运行限额；旧会话不会被管理员改动污染。平台凭据始终不可见。
                </p>
                {manifest.surfaces.includes('platform_admin') ? (
                  <Link href="/runtime-console?view=governance">
                    打开 Provider 治理
                  </Link>
                ) : null}
              </div>
            ) : null}

            {tab === 'security' ? (
              <div className={styles.formGrid}>
                <label>
                  审批策略
                  <select
                    value={draft.securityPolicy.approvalPolicy}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        securityPolicy: {
                          ...draft.securityPolicy,
                          approvalPolicy: event.target.value as Approval,
                        },
                      })
                    }
                  >
                    <option value="confirm_side_effects">有副作用时确认</option>
                    <option value="confirm_external">对外动作时确认</option>
                    <option value="autonomous">授权范围内自主</option>
                  </select>
                </label>
                <label>
                  连接器身份
                  <select
                    value={draft.securityPolicy.connectorIdentityModes.join(
                      ',',
                    )}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        securityPolicy: {
                          ...draft.securityPolicy,
                          connectorIdentityModes: event.target.value.split(
                            ',',
                          ) as ('user' | 'service')[],
                        },
                      })
                    }
                  >
                    <option value="user">仅用户身份</option>
                    <option value="user,service">用户与服务身份</option>
                  </select>
                </label>
                <fieldset className={styles.wide}>
                  <legend>允许的数据范围</legend>
                  {(
                    ['workspace', 'employee', 'user', 'organization'] as const
                  ).map((scope) => (
                    <label key={scope}>
                      <input
                        type="checkbox"
                        checked={draft.securityPolicy.dataScopes.includes(
                          scope,
                        )}
                        onChange={() =>
                          setDraft({
                            ...draft,
                            securityPolicy: {
                              ...draft.securityPolicy,
                              dataScopes: toggle(
                                draft.securityPolicy.dataScopes,
                                scope,
                              ) as Definition['securityPolicy']['dataScopes'],
                            },
                          })
                        }
                      />
                      {scope}
                    </label>
                  ))}
                </fieldset>
                <label className={styles.wide}>
                  安全边界（每行一条）
                  <textarea
                    value={draft.identity.safetyBoundaries.join('\n')}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identity: {
                          ...draft.identity,
                          safetyBoundaries: splitLines(event.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
            ) : null}

            {tab === 'members' ? (
              <div className={styles.memberAssignments}>
                <header>
                  <h2>可使用 {draft.name} 的成员</h2>
                  <p>
                    {selected.employeeKey === 'default-assistant'
                      ? 'Rice 是所有成员的默认通用员工，不需要单独分配。'
                      : '只有被管理员明确分配的成员会在员工目录和新会话中看到该员工。'}
                  </p>
                </header>
                {hub.members.map((member) => (
                  <label key={member.userId}>
                    <input
                      checked={
                        selected.employeeKey === 'default-assistant' ||
                        selectedMembers.includes(member.userId)
                      }
                      disabled={selected.employeeKey === 'default-assistant'}
                      onChange={() =>
                        setSelectedMembers(
                          toggle(selectedMembers, member.userId),
                        )
                      }
                      type="checkbox"
                    />
                    <span>
                      <strong>{member.displayName}</strong>
                      <small>
                        {member.email} · {member.role}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          {notice ? <div className={styles.notice}>{notice}</div> : null}
        </section>
      ) : null}
    </main>
  );
}

function CapabilityList({
  title,
  note,
  items,
  selected,
  onToggle,
}: {
  title: string;
  note: string;
  items: CatalogRevision[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <section className={styles.capabilityList}>
      <header>
        <h2>{title}</h2>
        <p>{note}</p>
      </header>
      {items.map((item) => (
        <label key={item.id}>
          <input
            checked={selected.includes(item.id)}
            onChange={() => onToggle(item.id)}
            type="checkbox"
          />
          <span>
            <strong>{item.name}</strong>
            <small>{item.description}</small>
          </span>
        </label>
      ))}
      {items.length === 0 ? (
        <span className={styles.empty}>尚无已发布能力</span>
      ) : null}
    </section>
  );
}
