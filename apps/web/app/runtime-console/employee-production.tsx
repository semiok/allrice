'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  PlatformEmployeeDefinition,
  PlatformEmployeeAuditEvent,
  PlatformEmployeeSummary,
  PlatformEmployeeTestRun,
} from '@allrice/contracts';
import {
  EMPLOYEE_PROVIDER_OPTIONS,
  employeeModelPolicyProblem,
  employeeReasoningSettings,
  switchEmployeeModelProvider,
} from '@allrice/contracts';

import styles from './employee-production.module.css';

type Employee = PlatformEmployeeSummary;

interface NativeSkill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  source: 'allrice' | 'dsh-migrated';
  sourceRef: string;
  version: string;
  license: string;
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
}

interface Workspace {
  id: string;
  organizationName: string;
  slug: string;
  name: string;
  bridgeOnline: boolean;
  bridgeName: string | null;
  bridgeWorkspaceLabel: string | null;
  bridgeLastSeenAt: string | null;
}

interface DirectoryResponse {
  employees: Employee[];
  skills: NativeSkill[];
  workspaces: Workspace[];
}

const tabs = [
  ['basic', '基础'],
  ['persona', '人设'],
  ['skills', '技能'],
  ['workflows', 'Workflow'],
  ['knowledge', 'Knowledge'],
  ['model', '模型'],
  ['tools', '工具'],
  ['security', '安全'],
  ['debug', '调试'],
  ['publish', '发布租户'],
] as const;

const toolLabels: Record<string, string> = {
  'workspace.file.list': '工作区文件列表',
  'workspace.file.read': '读取工作区文件',
  'workspace.document.read': '解析工作区文档',
  'workspace.memory.search': '检索记忆',
  'workspace.session.search': '检索会话',
  'web.search': '联网搜索',
  'web.fetch': '读取网页',
  'browser.run': '云端浏览器',
  'wechat.article.search': '搜索公众号文章',
  'wechat.article.read': '读取公众号文章',
  'market.quote': '查询公开行情',
  'market.history': '查询历史行情',
  'workspace.export.create': '生成可下载交付物',
  'local.fs.list': '本地目录列表',
  'local.fs.search': '本地文件搜索',
  'local.fs.read': '读取本地文件',
  'local.fs.write': '新建或更新本地文本文件',
  'local.fs.mkdir': '新建本地目录',
  'local.git.status': '本地 Git 状态',
  'local.git.diff': '本地 Git 差异',
  'automation.create': '创建自动化',
};

const lifecycleActionLabels: Record<string, string> = {
  'employee.published': '发布成功',
  'employee.publish_rejected': '发布未通过',
  'employee.tenant_assigned': '新增租户分配',
  'employee.rolled_back': '发布回滚',
  'employee.disabled': '员工停用',
};

const publicationActions = new Set(Object.keys(lifecycleActionLabels));

async function api<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await response.json().catch(() => null)) as
    T | { error?: { message?: string } } | null;
  if (response.status === 401) {
    window.location.assign('/login?next=/runtime-console');
    throw new Error('需要登录');
  }
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function Field(props: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  multiline?: boolean;
  wide?: boolean;
  type?: string;
  runtimeSource?: string;
  runtimeSourceKind?: 'file' | 'policy';
}) {
  const className = `${styles.field} ${props.wide ? styles.fieldWide : ''}`;
  return (
    <label className={className}>
      <RuntimeFieldLabel
        label={props.label}
        runtimeSource={props.runtimeSource}
        runtimeSourceKind={props.runtimeSourceKind}
      />
      {props.multiline ? (
        <textarea
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <input
          type={props.type ?? 'text'}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function RuntimeFieldLabel(props: {
  label: string;
  runtimeSource?: string;
  runtimeSourceKind?: 'file' | 'policy';
}) {
  return (
    <span className={styles.fieldLabel}>
      <span>{props.label}</span>
      {props.runtimeSource ? (
        <code data-kind={props.runtimeSourceKind ?? 'file'}>
          {props.runtimeSource}
        </code>
      ) : null}
    </span>
  );
}

function Checks(props: {
  items: { id: string; label: string; detail: string; disabled?: boolean }[];
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  const selected = new Set(props.selected);
  return (
    <div className={styles.checks}>
      {props.items.map((item) => (
        <label className={styles.check} key={item.id}>
          <input
            type="checkbox"
            checked={selected.has(item.id)}
            disabled={item.disabled}
            onChange={(event) =>
              props.onChange(
                event.target.checked
                  ? [...selected, item.id]
                  : [...selected].filter((id) => id !== item.id),
              )
            }
          />
          <span>
            <strong>{item.label}</strong>
            <small>{item.detail}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

export function EmployeeProduction() {
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlatformEmployeeDefinition | null>(null);
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
  const [previewWorkspaceId, setPreviewWorkspaceId] = useState('');
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('basic');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testPrompt, setTestPrompt] = useState(
    '请用一句话说明你的名字、职责和工作方式。不要调用任何工具。',
  );
  const [testRuns, setTestRuns] = useState<PlatformEmployeeTestRun[]>([]);
  const [auditEvents, setAuditEvents] = useState<PlatformEmployeeAuditEvent[]>(
    [],
  );
  const [disableReason, setDisableReason] = useState('');
  const [rollbackReason, setRollbackReason] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newEmployeeKey, setNewEmployeeKey] = useState('');
  const [newEmployeeName, setNewEmployeeName] = useState('');
  const [archiveReason, setArchiveReason] = useState('');
  const hasPendingTestRuns = testRuns.some(
    (run) => run.status === 'queued' || run.status === 'running',
  );

  const previewWorkspace = useMemo(
    () =>
      directory?.workspaces.find(
        (workspace) => workspace.id === previewWorkspaceId,
      ) ?? null,
    [directory, previewWorkspaceId],
  );

  const load = useCallback(
    async (preferredId?: string) => {
      setBusy(true);
      try {
        const result = await api<DirectoryResponse>(
          '/api/v1/admin/platform-employees',
        );
        setDirectory(result);
        const nextId =
          preferredId &&
          result.employees.some((employee) => employee.id === preferredId)
            ? preferredId
            : selectedId &&
                result.employees.some((employee) => employee.id === selectedId)
              ? selectedId
              : (result.employees[0]?.id ?? null);
        setSelectedId(nextId);
        const employee = result.employees.find((item) => item.id === nextId);
        const definition =
          employee?.currentDraft?.definition ??
          employee?.currentPublished?.definition;
        setDraft(definition ? clone(definition) : null);
        setSelectedWorkspaces(employee?.assignedWorkspaceIds ?? []);
        setPreviewWorkspaceId((current) => {
          if (result.workspaces.some((workspace) => workspace.id === current)) {
            return current;
          }
          return (
            result.workspaces.find((workspace) =>
              `${workspace.organizationName} ${workspace.name} ${workspace.slug}`
                .toLowerCase()
                .includes('snow'),
            )?.id ??
            result.workspaces[0]?.id ??
            ''
          );
        });
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '加载失败');
      } finally {
        setBusy(false);
      }
    },
    [selectedId],
  );

  useEffect(() => {
    void load();
  }, []);

  const loadTestRuns = useCallback(async (employeeId: string) => {
    const result = await api<{ testRuns: PlatformEmployeeTestRun[] }>(
      `/api/v1/admin/platform-employees/${employeeId}/test-runs`,
    );
    setTestRuns(result.testRuns);
    return result.testRuns;
  }, []);

  const loadAuditEvents = useCallback(async (employeeId: string) => {
    const result = await api<{
      auditEvents: PlatformEmployeeAuditEvent[];
    }>(`/api/v1/admin/platform-employees/${employeeId}/lifecycle`);
    setAuditEvents(result.auditEvents);
    return result.auditEvents;
  }, []);

  useEffect(() => {
    if (tab !== 'debug' || !selectedId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const runs = await loadTestRuns(selectedId);
        if (
          !cancelled &&
          runs.some(
            (run) => run.status === 'queued' || run.status === 'running',
          )
        ) {
          timer = setTimeout(() => void poll(), 1_500);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : '读取测试结果失败',
          );
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasPendingTestRuns, loadTestRuns, selectedId, tab]);

  useEffect(() => {
    if (tab !== 'publish' || !selectedId) return;
    void loadAuditEvents(selectedId).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : '读取审计记录失败'),
    );
  }, [loadAuditEvents, selectedId, tab]);

  const selected = useMemo(
    () => directory?.employees.find((item) => item.id === selectedId) ?? null,
    [directory, selectedId],
  );
  const publicationEvents = useMemo(
    () => auditEvents.filter((event) => publicationActions.has(event.action)),
    [auditEvents],
  );

  function choose(employee: Employee) {
    setSelectedId(employee.id);
    const definition =
      employee.currentDraft?.definition ??
      employee.currentPublished?.definition;
    setDraft(definition ? clone(definition) : null);
    setSelectedWorkspaces(employee.assignedWorkspaceIds);
    setMessage('');
    setError('');
    setTestRuns([]);
    setAuditEvents([]);
  }

  function update(path: string[], value: unknown) {
    setDraft((current) => {
      if (!current) return current;
      const next = clone(current) as unknown as Record<string, unknown>;
      let cursor = next;
      for (const key of path.slice(0, -1)) {
        cursor = cursor[key] as Record<string, unknown>;
      }
      cursor[path.at(-1)!] = value;
      return next as unknown as PlatformEmployeeDefinition;
    });
  }

  async function refresh() {
    await load(selectedId ?? undefined);
    if (tab === 'debug' && selectedId) {
      try {
        await loadTestRuns(selectedId);
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : '读取配置试用结果失败',
        );
      }
    }
  }

  async function save() {
    if (!selectedId || !draft) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{
        employee: Employee;
        validation: {
          valid: boolean;
          errors: string[];
          warnings: string[];
        };
      }>(`/api/v1/admin/platform-employees/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({ definition: draft }),
      });
      await load();
      if (!result.validation.valid) {
        setError(result.validation.errors.join('\n'));
        setMessage('草稿已保存，但配置检查未通过。请按提示修改对应配置。');
      } else {
        setMessage(
          result.validation.warnings.join('\n') ||
            '草稿已保存，模型、Skill、工具与安全配置检查通过。',
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function createEmployee() {
    if (!newEmployeeKey.trim() || !newEmployeeName.trim()) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{ employee: Employee }>(
        '/api/v1/admin/platform-employees',
        {
          method: 'POST',
          body: JSON.stringify({
            key: newEmployeeKey.trim(),
            name: newEmployeeName.trim(),
            sourceEmployeeId: selectedId ?? undefined,
          }),
        },
      );
      setShowCreate(false);
      setNewEmployeeKey('');
      setNewEmployeeName('');
      setTab('basic');
      setMessage('已创建平台员工草稿，尚未测试或发布给任何租户。');
      await load(result.employee.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建员工失败');
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!selectedId) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{
        valid: boolean;
        errors: string[];
        revisionId: string;
        workspaceIds: string[];
      }>(`/api/v1/admin/platform-employees/${selectedId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ workspaceIds: selectedWorkspaces }),
      });
      if (!result.valid) throw new Error(result.errors.join('\n'));
      setMessage(
        `发布成功：revision ${result.revisionId.slice(0, 8)} 已发布到 ${result.workspaceIds.length} 个工作区。新会话生效，现有会话保持原版本。`,
      );
      await Promise.all([load(), loadAuditEvents(selectedId)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发布失败');
      void loadAuditEvents(selectedId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function runDraftPreview() {
    if (!selectedId || !draft || !testPrompt.trim() || !previewWorkspaceId)
      return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const saved = await api<{
        employee: Employee;
        validation: {
          valid: boolean;
          errors: string[];
          warnings: string[];
        };
      }>(`/api/v1/admin/platform-employees/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({ definition: draft }),
      });
      if (!saved.validation.valid) {
        throw new Error(saved.validation.errors.join('\n'));
      }
      const result = await api<{
        queued: boolean;
        valid: boolean;
        errors: string[];
        testRun: PlatformEmployeeTestRun | null;
      }>(`/api/v1/admin/platform-employees/${selectedId}/test-runs`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: testPrompt,
          workspaceId: previewWorkspaceId,
        }),
      });
      if (!result.queued || !result.testRun) {
        throw new Error(result.errors.join('\n') || '员工草稿未通过编译');
      }
      setTestRuns((current) => [result.testRun!, ...current]);
      const workspace = directory?.workspaces.find(
        (candidate) => candidate.id === previewWorkspaceId,
      );
      setMessage(
        `已使用${workspace ? `「${workspace.name}」` : '所选租户'}的真实模型、Skill、Tool Broker 和在线 Bridge 试用当前配置；不会改变已发布版本。`,
      );
      await loadTestRuns(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '当前配置试用失败');
    } finally {
      setBusy(false);
    }
  }

  async function disableEmployee() {
    if (!selectedId || !disableReason.trim()) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api(`/api/v1/admin/platform-employees/${selectedId}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ action: 'disable', reason: disableReason }),
      });
      setDisableReason('');
      setMessage('员工已停用，租户的新会话和后续调用不再获得该员工。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '停用失败');
    } finally {
      setBusy(false);
    }
  }

  async function rollbackEmployee() {
    if (!selectedId || !rollbackReason.trim()) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{ revision: number }>(
        `/api/v1/admin/platform-employees/${selectedId}/lifecycle`,
        {
          method: 'POST',
          body: JSON.stringify({
            action: 'rollback',
            reason: rollbackReason,
          }),
        },
      );
      setRollbackReason('');
      setMessage(
        `已回滚到发布 revision ${result.revision}，仅影响租户新 Session。`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '回滚失败');
    } finally {
      setBusy(false);
    }
  }

  async function archiveEmployee() {
    if (!selectedId || !archiveReason.trim()) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api(`/api/v1/admin/platform-employees/${selectedId}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({ action: 'archive', reason: archiveReason }),
      });
      setArchiveReason('');
      setMessage('员工已归档并从全部租户撤回。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '归档失败');
    } finally {
      setBusy(false);
    }
  }

  if (!directory || !selected || !draft) {
    return (
      <p className={error ? styles.error : styles.notice}>
        {error || '正在读取 AI 员工…'}
      </p>
    );
  }

  let panel: React.ReactNode;
  if (tab === 'basic') {
    panel = (
      <div className={styles.grid}>
        <Field
          label="名称"
          value={draft.name}
          onChange={(value) => update(['name'], value)}
        />
        <Field
          label="员工 Key"
          value={draft.key}
          onChange={(value) => update(['key'], value)}
        />
        <Field
          label="简介"
          value={draft.description}
          multiline
          wide
          onChange={(value) => update(['description'], value)}
        />
        <Field
          label="头像内容"
          value={draft.appearance.avatarValue}
          onChange={(value) => update(['appearance', 'avatarValue'], value)}
        />
      </div>
    );
  } else if (tab === 'persona') {
    panel = (
      <>
        <section className={styles.runtimeFileMap}>
          <header>
            <strong>运行时文件映射</strong>
            <span>发布时动态生成，不是仓库里的实体 Markdown 文件</span>
          </header>
          <div>
            <article>
              <code>IDENTITY.md</code>
              <span>员工身份、使命和工作方式</span>
            </article>
            <article>
              <code>SOUL.md</code>
              <span>行为准则、安全边界和操作确认策略</span>
            </article>
            <article>
              <code>AGENTS.md</code>
              <span>由工作规则、已选 Skill 目录和路由规则自动生成</span>
            </article>
            <article>
              <code>USER.md</code>
              <span>按当前租户和用户授权动态注入，无独立输入框</span>
            </article>
          </div>
          <p>“系统提示词”属于更高优先级的平台硬策略，不写入上述虚拟文件。</p>
        </section>
        <div className={styles.grid}>
          <Field
            label="角色"
            runtimeSource="IDENTITY.md"
            value={draft.identity.role}
            onChange={(value) => update(['identity', 'role'], value)}
          />
          <Field
            label="使命"
            runtimeSource="IDENTITY.md"
            value={draft.identity.mission}
            onChange={(value) => update(['identity', 'mission'], value)}
          />
          <Field
            label="工作方式"
            runtimeSource="IDENTITY.md"
            value={draft.identity.workStyle}
            multiline
            wide
            onChange={(value) => update(['identity', 'workStyle'], value)}
          />
          <Field
            label="系统提示词"
            runtimeSource="平台硬策略"
            runtimeSourceKind="policy"
            value={draft.systemPrompt}
            multiline
            wide
            onChange={(value) => update(['systemPrompt'], value)}
          />
          <Field
            label="行为准则（每行一条）"
            runtimeSource="SOUL.md"
            value={draft.identity.behaviorRules.join('\n')}
            multiline
            onChange={(value) =>
              update(
                ['identity', 'behaviorRules'],
                value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
          <Field
            label="安全边界（每行一条）"
            runtimeSource="SOUL.md"
            value={draft.identity.safetyBoundaries.join('\n')}
            multiline
            onChange={(value) =>
              update(
                ['identity', 'safetyBoundaries'],
                value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              )
            }
          />
        </div>
      </>
    );
  } else if (tab === 'skills') {
    panel = (
      <>
        <div className={styles.runtimeSourceNotice}>
          <div>
            <code>AGENTS.md</code>
            <span>根据已选 Skill 自动生成目录和自主路由说明</span>
          </div>
          <div>
            <code>SKILL.md</code>
            <span>每个已选 Skill 作为独立、不可变的发布快照传入运行时</span>
          </div>
        </div>
        {directory.skills.length ? (
          <Checks
            items={directory.skills.map((skill) => ({
              id: skill.id,
              label: skill.name,
              detail: `${skill.source === 'dsh-migrated' ? 'DSH 迁移' : 'AllRice 自有'} · v${skill.version} · ${skill.license} · ${skill.reviewStatus === 'reviewed' ? '已审核' : '未通过审核'} · ${skill.description}`,
              disabled: !skill.enabled || skill.reviewStatus !== 'reviewed',
            }))}
            selected={draft.capabilities.nativeSkillIds}
            onChange={(value) =>
              update(['capabilities', 'nativeSkillIds'], value)
            }
          />
        ) : (
          <p className={styles.notice}>
            平台原生 Skill 库当前为空。先审核并迁移 Skill，再装配给 Rice。
          </p>
        )}
      </>
    );
  } else if (tab === 'workflows') {
    panel = (
      <p className={styles.notice}>
        Workflow 是独立的确定性流程能力，不伪装成 Skill。平台级 Workflow
        发布目录尚未启用，因此当前草稿不能引用租户 Workflow。
      </p>
    );
  } else if (tab === 'knowledge') {
    panel = (
      <p className={styles.notice}>
        Knowledge 是独立的受权限知识能力，不伪装成 Skill。平台级 Knowledge
        发布目录尚未启用，因此当前草稿不能引用租户 Knowledge。
      </p>
    );
  } else if (tab === 'model') {
    const reasoning = employeeReasoningSettings(
      draft.modelPolicy.provider,
      draft.modelPolicy.model,
    );
    const modelProblem = employeeModelPolicyProblem(draft.modelPolicy);
    panel = (
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Provider</span>
          <select
            value={draft.modelPolicy.provider}
            aria-label="Provider"
            onChange={(event) => {
              const provider = event.target.value;
              if (provider !== 'gemini' && provider !== 'openai-codex') return;
              setDraft((current) =>
                current
                  ? {
                      ...current,
                      modelPolicy: switchEmployeeModelProvider(
                        current.modelPolicy,
                        provider,
                      ),
                    }
                  : current,
              );
            }}
          >
            {!EMPLOYEE_PROVIDER_OPTIONS.some(
              (item) => item.value === draft.modelPolicy.provider,
            ) ? (
              <option value={draft.modelPolicy.provider} disabled>
                历史配置（已停止新配置）
              </option>
            ) : null}
            {EMPLOYEE_PROVIDER_OPTIONS.map((item) => (
              <option value={item.value} key={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="模型"
          value={draft.modelPolicy.model}
          onChange={(model) =>
            setDraft((current) => {
              if (!current) return current;
              const settings = employeeReasoningSettings(
                current.modelPolicy.provider,
                model,
              );
              return {
                ...current,
                modelPolicy: {
                  ...current.modelPolicy,
                  model,
                  reasoningEffort:
                    settings.efforts.length &&
                    !settings.efforts.includes(
                      current.modelPolicy.reasoningEffort,
                    )
                      ? settings.defaultEffort
                      : current.modelPolicy.reasoningEffort,
                },
              };
            })
          }
        />
        <label className={styles.field}>
          <span>{reasoning.label}</span>
          <select
            value={draft.modelPolicy.reasoningEffort}
            aria-label={reasoning.label}
            disabled={!reasoning.efforts.length}
            onChange={(event) =>
              update(['modelPolicy', 'reasoningEffort'], event.target.value)
            }
          >
            {!reasoning.efforts.includes(draft.modelPolicy.reasoningEffort) ? (
              <option value={draft.modelPolicy.reasoningEffort} disabled>
                {draft.modelPolicy.reasoningEffort}（原配置，请重新选择）
              </option>
            ) : null}
            {reasoning.efforts.map((value) => (
              <option value={value} key={value}>
                {
                  {
                    none: '关闭',
                    low: '低',
                    medium: '中',
                    high: '高',
                    xhigh: '超高',
                  }[value]
                }{' '}
                · {value}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="超时（毫秒）"
          type="number"
          value={draft.modelPolicy.timeoutMs}
          onChange={(value) =>
            update(['modelPolicy', 'timeoutMs'], Number(value))
          }
        />
        {modelProblem ? (
          <p className={`${styles.notice} ${styles.fieldWide}`} role="alert">
            {modelProblem}
          </p>
        ) : null}
        <p className={`${styles.notice} ${styles.fieldWide}`}>
          仅显示当前 AllRice 版本已接通的模型档位；不同 Provider
          的同名档位并不代表相同的计算量。修改只保存为草稿，不改变已发布员工或正在运行的会话。
        </p>
        {draft.modelPolicy.provider === 'gemini' ? (
          <p className={`${styles.notice} ${styles.fieldWide}`}>
            Gemini 使用 Google API 密钥，独立于 Codex 订阅和 Gemini
            网页订阅计费。 平台需先配置 API 密钥、开启 Gemini API
            执行开关并完成预览与发布检查；这里只编辑草稿，不会自动启用或证明连接成功。
          </p>
        ) : null}
      </div>
    );
  } else if (tab === 'tools') {
    panel = (
      <Checks
        items={Object.entries(toolLabels).map(([id, label]) => ({
          id,
          label,
          detail: id,
        }))}
        selected={draft.capabilities.toolNames}
        onChange={(value) => update(['capabilities', 'toolNames'], value)}
      />
    );
  } else if (tab === 'security') {
    panel = (
      <div className={styles.grid}>
        <label className={styles.field}>
          <RuntimeFieldLabel label="操作确认策略" runtimeSource="SOUL.md" />
          <select
            value={draft.securityPolicy.approvalPolicy}
            onChange={(event) =>
              update(['securityPolicy', 'approvalPolicy'], event.target.value)
            }
          >
            <option value="confirm_side_effects">所有修改前询问</option>
            <option value="confirm_external">对外操作前询问</option>
            <option value="autonomous">已授权范围内自动执行</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>Rice Bridge</span>
          <select
            value={draft.securityPolicy.bridgeAccess}
            onChange={(event) =>
              update(['securityPolicy', 'bridgeAccess'], event.target.value)
            }
          >
            <option value="none">禁用</option>
            <option value="read_only">只读</option>
            <option value="read_write">受控读写</option>
          </select>
        </label>
        <p className={`${styles.notice} ${styles.fieldWide}`}>
          “受控读写”只允许已授权目录内的新建目录和文本文件原子写入；覆盖前必须校验
          SHA-256。AllRice 始终执行租户隔离、Tool Broker
          权限交集和审计。这里不会开放 Shell、删除或 Git
          写操作，也不会把模型密钥下发给租户或 Bridge。
        </p>
      </div>
    );
  } else if (tab === 'debug') {
    panel = (
      <>
        <p className={styles.notice}>
          试用会先保存并自动检查当前草稿，然后借用所选租户真实可用的模型、Skill、
          Tool Broker 运行一次预览。预览不会改变该租户已经发布的 Rice
          配置，也不会进入租户的正式会话。
        </p>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span>预览环境</span>
          <select
            value={previewWorkspaceId}
            onChange={(event) => setPreviewWorkspaceId(event.target.value)}
          >
            <option value="">请选择租户</option>
            {directory.workspaces.map((workspace) => (
              <option value={workspace.id} key={workspace.id}>
                {workspace.name} · {workspace.organizationName}
              </option>
            ))}
          </select>
          {previewWorkspace ? (
            <small>
              Bridge 与本地工作区状态请在“Runtime 状态”中按租户查看。
            </small>
          ) : null}
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span>测试任务</span>
          <textarea
            value={testPrompt}
            onChange={(event) => setTestPrompt(event.target.value)}
          />
        </label>
        <div className={styles.actions}>
          <button
            className={styles.button}
            data-primary="true"
            disabled={busy || !testPrompt.trim() || !previewWorkspaceId}
            onClick={() => void runDraftPreview()}
          >
            {busy ? '启动中…' : '试用当前配置'}
          </button>
        </div>
        <div className={styles.testRuns}>
          {testRuns.length === 0 ? (
            <p className={styles.muted}>还没有配置试用记录。</p>
          ) : (
            testRuns.map((run) => (
              <article className={styles.testRun} key={run.id}>
                <header>
                  <strong>{run.status}</strong>
                  <time>{new Date(run.createdAt).toLocaleString('zh-CN')}</time>
                </header>
                <p className={styles.testPrompt}>{run.input.prompt}</p>
                {run.input.workspaceId ? (
                  <small className={styles.muted}>
                    预览环境：
                    {directory.workspaces.find(
                      (workspace) => workspace.id === run.input.workspaceId,
                    )?.name ?? run.input.workspaceId}
                  </small>
                ) : null}
                {run.output?.events.length ? (
                  <ol className={styles.testEvents}>
                    {run.output.events
                      .filter(
                        (event) =>
                          event.type === 'native.event' ||
                          event.type.startsWith('tool.'),
                      )
                      .map((event, index) => (
                        <li key={`${run.id}-${event.order}-${index}`}>
                          {event.type === 'native.event'
                            ? `${event.label}${event.summary ? ` · ${event.summary}` : ''}`
                            : event.type === 'tool.started' ||
                                event.type === 'tool.completed' ||
                                event.type === 'tool.failed'
                              ? `${event.name} · ${event.type.replace('tool.', '')}`
                              : event.type}
                        </li>
                      ))}
                  </ol>
                ) : null}
                {run.output?.answer ? (
                  <pre className={styles.testAnswer}>{run.output.answer}</pre>
                ) : null}
                {run.output?.usage ? (
                  <small className={styles.muted}>
                    {run.output.provider} · {run.output.model} · 输入{' '}
                    {run.output.usage.inputTokens} / 输出{' '}
                    {run.output.usage.outputTokens} tokens
                  </small>
                ) : null}
                {run.output?.error ? (
                  <p className={styles.error}>
                    {run.output.error.code} · {run.output.error.message}
                  </p>
                ) : null}
              </article>
            ))
          )}
        </div>
      </>
    );
  } else {
    panel = (
      <>
        <section className={styles.publishStatus}>
          <h3>当前发布状态</h3>
          {selected.currentPublished ? (
            <>
              <strong>
                正式版本：revision {selected.currentPublished.revision}
              </strong>
              <span>
                {selected.currentPublished.publishedAt
                  ? new Date(
                      selected.currentPublished.publishedAt,
                    ).toLocaleString('zh-CN')
                  : '发布时间未知'}{' '}
                · 已分配 {selected.assignedWorkspaceIds.length} 个租户工作区
              </span>
            </>
          ) : (
            <strong>尚未发布正式版本</strong>
          )}
          {selected.currentDraft &&
          selected.currentDraft.id !== selected.currentPublished?.id ? (
            <p>
              待发布：revision {selected.currentDraft.revision} ·{' '}
              {selected.currentDraft.status}
              。只有发布成功后才会替换上面的正式版本。
            </p>
          ) : null}
        </section>
        <p className={styles.muted}>
          这里只显示真实租户工作区，不包含 Platform Control
          Plane。发布生成不可变修订； 新会话生效，已有会话保持原版本。
        </p>
        <Checks
          items={directory.workspaces.map((workspace) => ({
            id: workspace.id,
            label: workspace.name,
            detail: `${workspace.organizationName} · ${workspace.slug}`,
          }))}
          selected={selectedWorkspaces}
          onChange={setSelectedWorkspaces}
        />
        <button
          className={styles.button}
          data-primary="true"
          disabled={busy || selectedWorkspaces.length === 0}
          onClick={() => void publish()}
        >
          {busy ? '发布中…' : '发布到所选租户'}
        </button>
        {error ? <p className={styles.error}>{error}</p> : null}
        {message ? <p className={styles.notice}>{message}</p> : null}
        <section className={styles.dangerZone}>
          <h3>回滚发布</h3>
          <p className={styles.muted}>
            将当前分配的租户恢复到上一个不可变发布快照；已有 Session
            保持原快照。
          </p>
          <Field
            label="回滚原因"
            value={rollbackReason}
            wide
            onChange={setRollbackReason}
          />
          <button
            className={styles.button}
            disabled={busy || !rollbackReason.trim()}
            onClick={() => void rollbackEmployee()}
          >
            回滚到上一发布
          </button>
        </section>
        <section className={styles.dangerZone}>
          <h3>停用员工</h3>
          <p className={styles.muted}>
            停用会撤回全部租户分配，不删除不可变版本和审计记录。重新发布可恢复。
          </p>
          <Field
            label="停用原因"
            value={disableReason}
            wide
            onChange={setDisableReason}
          />
          <button
            className={styles.dangerButton}
            disabled={busy || !disableReason.trim()}
            onClick={() => void disableEmployee()}
          >
            停用并撤回租户分配
          </button>
        </section>
        <section className={styles.audit}>
          <h3>发布记录</h3>
          {publicationEvents.length ? (
            publicationEvents.map((event) => {
              const revisionId =
                typeof event.details.revisionId === 'string'
                  ? event.details.revisionId
                  : null;
              const revision = [
                selected.currentDraft,
                selected.currentPublished,
              ].find((candidate) => candidate?.id === revisionId);
              const workspaceIds = Array.isArray(event.details.workspaceIds)
                ? event.details.workspaceIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : typeof event.details.workspaceId === 'string'
                  ? [event.details.workspaceId]
                  : [];
              const workspaceNames = workspaceIds.map(
                (workspaceId) =>
                  directory.workspaces.find(
                    (workspace) => workspace.id === workspaceId,
                  )?.name ?? workspaceId,
              );
              const errors = Array.isArray(event.details.errors)
                ? event.details.errors.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [];
              return (
                <div key={event.id}>
                  <span className={styles.auditSummary}>
                    <strong>
                      {lifecycleActionLabels[event.action] ?? event.action}
                    </strong>
                    {revisionId ? (
                      <small>
                        版本：
                        {revision
                          ? `revision ${revision.revision}`
                          : revisionId.slice(0, 8)}
                      </small>
                    ) : null}
                    {workspaceNames.length ? (
                      <small>租户：{workspaceNames.join('、')}</small>
                    ) : null}
                    {errors.length ? <small>{errors.join('；')}</small> : null}
                  </span>
                  <span>
                    {new Date(event.createdAt).toLocaleString('zh-CN')} ·{' '}
                    {event.actorLabel}
                  </span>
                </div>
              );
            })
          ) : (
            <p className={styles.muted}>还没有发布记录。</p>
          )}
        </section>
        {selected.employeeKey !== 'rice' ? (
          <section className={styles.dangerZone}>
            <h3>归档员工</h3>
            <p className={styles.muted}>
              归档会撤回全部租户分配并从员工目录隐藏；Rice 不允许归档。
            </p>
            <Field
              label="归档原因"
              value={archiveReason}
              wide
              onChange={setArchiveReason}
            />
            <button
              className={styles.dangerButton}
              disabled={busy || !archiveReason.trim()}
              onClick={() => void archiveEmployee()}
            >
              归档员工
            </button>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <section className={styles.shell}>
      <aside className={styles.rail}>
        <h2>AI 员工</h2>
        <p className={styles.muted}>平台生产后台 · 租户不可见</p>
        <button
          className={styles.createToggle}
          disabled={busy}
          onClick={() => setShowCreate((current) => !current)}
        >
          + 新建员工草稿
        </button>
        {showCreate ? (
          <div className={styles.createForm}>
            <label>
              <span>员工名称</span>
              <input
                value={newEmployeeName}
                onChange={(event) => setNewEmployeeName(event.target.value)}
              />
            </label>
            <label>
              <span>员工 Key</span>
              <input
                placeholder="lowercase-key"
                value={newEmployeeKey}
                onChange={(event) => setNewEmployeeKey(event.target.value)}
              />
            </label>
            <small>从当前员工复制为未发布草稿，不继承租户分配。</small>
            <button
              className={styles.button}
              data-primary="true"
              disabled={
                busy || !newEmployeeName.trim() || !newEmployeeKey.trim()
              }
              onClick={() => void createEmployee()}
            >
              创建草稿
            </button>
          </div>
        ) : null}
        <div className={styles.employeeList}>
          {directory.employees.map((employee) => (
            <button
              className={styles.employee}
              data-active={employee.id === selectedId}
              key={employee.id}
              onClick={() => choose(employee)}
            >
              <strong>{employee.name}</strong>
              <small>
                {employee.status} · {employee.assignedWorkspaceIds.length}{' '}
                个工作区
              </small>
            </button>
          ))}
        </div>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <div>
            <h1>{selected.name}</h1>
            <div className={styles.headerStatuses}>
              <span className={styles.status}>{selected.status}</span>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              className={styles.button}
              disabled={busy}
              onClick={() => void refresh()}
            >
              刷新
            </button>
            <button
              className={styles.button}
              data-primary="true"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? '处理中…' : '保存草稿'}
            </button>
          </div>
        </header>
        <nav className={styles.tabs}>
          {tabs.map(([id, label]) => (
            <button
              className={styles.tab}
              data-active={tab === id}
              key={id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className={styles.panel}>{panel}</div>
        {error && tab !== 'publish' ? (
          <p className={styles.error}>{error}</p>
        ) : null}
        {message &&
        tab !== 'publish' &&
        !message.startsWith('Snow Rice Bridge') ? (
          <p className={styles.notice}>{message}</p>
        ) : null}
      </div>
    </section>
  );
}
