'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  PlatformEmployeeDefinition,
  PlatformEmployeeAuditEvent,
  PlatformEmployeeSummary,
  PlatformEmployeeTestRun,
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
  'local.git.status': '本地 Git 状态',
  'local.git.diff': '本地 Git 差异',
  'automation.create': '创建自动化',
};

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
}) {
  const className = `${styles.field} ${props.wide ? styles.fieldWide : ''}`;
  return (
    <label className={className}>
      <span>{props.label}</span>
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
  const [bridgeControlState, setBridgeControlState] = useState<
    'running' | 'stopped' | null
  >(null);
  const [bridgeControlBusy, setBridgeControlBusy] = useState(false);
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
  const previewBridgeOnline =
    bridgeControlState === null
      ? (previewWorkspace?.bridgeOnline ?? false)
      : bridgeControlState === 'running';

  const loadBridgeControlState = useCallback(async () => {
    try {
      const result = await api<{ state: 'running' | 'stopped' }>(
        '/api/v1/admin/bridge-control',
      );
      setBridgeControlState(result.state);
    } catch {
      setBridgeControlState(null);
    }
  }, []);

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
    void api<{ auditEvents: PlatformEmployeeAuditEvent[] }>(
      `/api/v1/admin/platform-employees/${selectedId}/lifecycle`,
    )
      .then((result) => setAuditEvents(result.auditEvents))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '读取审计记录失败'),
      );
  }, [selectedId, tab]);

  useEffect(() => {
    if (!previewWorkspaceId) return;
    void loadBridgeControlState();
    const timer = setInterval(() => {
      void loadBridgeControlState();
    }, 5 * 60_000);
    return () => clearInterval(timer);
  }, [loadBridgeControlState, previewWorkspaceId]);

  const selected = useMemo(
    () => directory?.employees.find((item) => item.id === selectedId) ?? null,
    [directory, selectedId],
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
    await Promise.all([
      load(selectedId ?? undefined),
      loadBridgeControlState(),
    ]);
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

  async function controlBridge(action: 'start' | 'stop') {
    setBridgeControlBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{ state: 'running' | 'stopped' }>(
        '/api/v1/admin/bridge-control',
        {
          method: 'POST',
          body: JSON.stringify({ action }),
        },
      );
      setBridgeControlState(result.state);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '控制 Bridge 失败');
    } finally {
      setBridgeControlBusy(false);
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
        workspaceIds: string[];
      }>(`/api/v1/admin/platform-employees/${selectedId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ workspaceIds: selectedWorkspaces }),
      });
      if (!result.valid) throw new Error(result.errors.join('\n'));
      setMessage(
        `已发布到 ${result.workspaceIds.length} 个工作区。新会话生效，现有会话保持原版本。`,
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发布失败');
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
      <div className={styles.grid}>
        <Field
          label="角色"
          value={draft.identity.role}
          onChange={(value) => update(['identity', 'role'], value)}
        />
        <Field
          label="使命"
          value={draft.identity.mission}
          onChange={(value) => update(['identity', 'mission'], value)}
        />
        <Field
          label="工作方式"
          value={draft.identity.workStyle}
          multiline
          wide
          onChange={(value) => update(['identity', 'workStyle'], value)}
        />
        <Field
          label="系统提示词"
          value={draft.systemPrompt}
          multiline
          wide
          onChange={(value) => update(['systemPrompt'], value)}
        />
        <Field
          label="行为准则（每行一条）"
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
    );
  } else if (tab === 'skills') {
    panel = directory.skills.length ? (
      <Checks
        items={directory.skills.map((skill) => ({
          id: skill.id,
          label: skill.name,
          detail: `${skill.source === 'dsh-migrated' ? 'DSH 迁移' : 'AllRice 自有'} · v${skill.version} · ${skill.license} · ${skill.reviewStatus === 'reviewed' ? '已审核' : '未通过审核'} · ${skill.description}`,
          disabled: !skill.enabled || skill.reviewStatus !== 'reviewed',
        }))}
        selected={draft.capabilities.nativeSkillIds}
        onChange={(value) => update(['capabilities', 'nativeSkillIds'], value)}
      />
    ) : (
      <p className={styles.notice}>
        平台原生 Skill 库当前为空。先审核并迁移 Skill，再装配给 Rice。
      </p>
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
    panel = (
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Provider</span>
          <select
            value={draft.modelPolicy.provider}
            onChange={(event) =>
              update(['modelPolicy', 'provider'], event.target.value)
            }
          >
            <option value="openai-codex">Codex 订阅</option>
            <option value="deepseek-official">DeepSeek API</option>
            <option value="openai-compatible">OpenAI Compatible</option>
          </select>
        </label>
        <Field
          label="模型"
          value={draft.modelPolicy.model}
          onChange={(value) => update(['modelPolicy', 'model'], value)}
        />
        <label className={styles.field}>
          <span>推理强度</span>
          <select
            value={draft.modelPolicy.reasoningEffort}
            onChange={(event) =>
              update(['modelPolicy', 'reasoningEffort'], event.target.value)
            }
          >
            {['none', 'low', 'medium', 'high', 'xhigh'].map((value) => (
              <option value={value} key={value}>
                {value}
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
          <span>操作确认策略</span>
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
          </select>
        </label>
        <p className={`${styles.notice} ${styles.fieldWide}`}>
          AllRice 始终执行租户隔离、Tool Broker
          权限交集、审批和审计。这里不会开放 Shell，也不会把模型密钥下发给租户或
          Bridge。
        </p>
      </div>
    );
  } else if (tab === 'debug') {
    panel = (
      <>
        <p className={styles.notice}>
          试用会先保存并自动检查当前草稿，然后借用所选租户真实可用的模型、Skill、
          Tool Broker 和在线 Rice Bridge
          运行一次预览。预览不会改变该租户已经发布的 Rice
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
                {workspace.name} · {workspace.organizationName} · Bridge
                {workspace.id === previewWorkspaceId
                  ? previewBridgeOnline
                    ? '在线'
                    : '离线'
                  : workspace.bridgeOnline
                    ? '在线'
                    : '离线'}
              </option>
            ))}
          </select>
          {previewWorkspace ? (
            <small
              className={
                previewBridgeOnline
                  ? styles.previewBridgeOnline
                  : styles.previewBridgeOffline
              }
            >
              {previewBridgeOnline
                ? `Rice Bridge 在线${previewWorkspace.bridgeWorkspaceLabel ? ` · 本地工作区：${previewWorkspace.bridgeWorkspaceLabel}` : ''}`
                : `Rice Bridge 离线${previewWorkspace.bridgeLastSeenAt ? ` · 最后在线：${new Date(previewWorkspace.bridgeLastSeenAt).toLocaleString('zh-CN')}` : ''}。联网等云端能力仍可试用，本地文件能力暂不可用。`}
            </small>
          ) : null}
        </label>
        {previewWorkspace ? (
          <div className={styles.actions}>
            <button
              className={styles.button}
              disabled={bridgeControlBusy}
              onClick={() =>
                void controlBridge(previewBridgeOnline ? 'stop' : 'start')
              }
            >
              {bridgeControlBusy
                ? '处理中…'
                : previewBridgeOnline
                  ? '关闭 Bridge'
                  : '启动 Bridge'}
            </button>
          </div>
        ) : null}
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
          <h3>审计记录</h3>
          {auditEvents.length ? (
            auditEvents.map((event) => (
              <div key={event.id}>
                <strong>{event.action}</strong>
                <span>
                  {new Date(event.createdAt).toLocaleString('zh-CN')} ·{' '}
                  {event.actorLabel}
                </span>
              </div>
            ))
          ) : (
            <p className={styles.muted}>还没有生命周期审计记录。</p>
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
              <span
                className={
                  previewBridgeOnline
                    ? styles.bridgeStatusOnline
                    : styles.bridgeStatusOffline
                }
              >
                Snow Bridge {previewBridgeOnline ? '在线' : '已关闭'}
              </span>
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
        {error ? <p className={styles.error}>{error}</p> : null}
        {message && !message.startsWith('Snow Rice Bridge') ? (
          <p className={styles.notice}>{message}</p>
        ) : null}
      </div>
    </section>
  );
}
