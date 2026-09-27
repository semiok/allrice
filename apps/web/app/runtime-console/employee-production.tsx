'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  employeeToolCatalog,
  prepareEmployeeEditorDefinition,
  employeeColorPalette,
  employeeColorForeground,
  resolveEmployeeAccent,
  type EmployeePaletteColor,
} from '@allrice/contracts';

import styles from './employee-production.module.css';
import { EmployeeToolTree, employeeSkillLabel } from './employee-tool-tree';
import { GeminiCredentialSettings } from './gemini-credential-settings';

type Employee = PlatformEmployeeSummary;

interface NativeSkill {
  requiredToolRefs: string[];
  replaces?: string[];
  bundleChecksum?: string | null;
  resourceCount?: number;
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
  trialUrl?: string | null;
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
  rapidIteration?: boolean;
  employees: Employee[];
  skills: NativeSkill[];
  workspaces: Workspace[];
  tools?: ((typeof employeeToolCatalog)[number] & { released: boolean })[];
}

interface PublicationReview {
  employeeId: string;
  revisionId: string;
  publishedRevisionId: string | null;
  packageChecksum: string | null;
  targets: {
    id: string;
    organizationId: string;
    organizationName: string;
    name: string;
    version: number | null;
  }[];
  policyVersions: Record<string, number | null>;
  diff: { field: string; before: unknown; after: unknown }[];
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function publicationMessage(result: {
  receipt: { companyCount: number; peopleCount: number };
}) {
  return result.receipt.companyCount
    ? `已更新 ${result.receipt.companyCount} 家公司、${result.receipt.peopleCount} 名员工。现有会话的下一轮使用新版，进行中的工作保持原版本。`
    : '已发布到 AI 员工目录，当前没有需要更新的配发。可前往组织管理为员工配发。';
}

const tabs = [
  ['basic', '基础'],
  ['persona', '人设'],
  ['skills', '技能'],
  ['workflows', 'Workflow'],
  ['knowledge', 'Knowledge'],
  ['model', '模型'],
  ['tools', '工具'],
  ['debug', '测试'],
  ['publish', '发布更新'],
] as const;

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
  const [review, setReview] = useState<PublicationReview | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const reviewSequence = useRef(0);
  const [skillView, setSkillView] = useState<Record<string, unknown> | null>(
    null,
  );
  const skillSequence = useRef(0);
  const invalidateReview = () => {
    reviewSequence.current++;
    setReview(null);
    setConfirmed(false);
  };
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlatformEmployeeDefinition | null>(null);
  const [previewWorkspaceId, setPreviewWorkspaceId] = useState('');
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('basic');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [testPrompt, setTestPrompt] = useState(
    '请用一句话说明你的名字、职责和工作方式。不要调用任何工具。',
  );
  const [testRuns, setTestRuns] = useState<PlatformEmployeeTestRun[]>([]);
  const [trialTargets, setTrialTargets] = useState<
    { workspaceId: string; employeeId: string }[]
  >([]);
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
      invalidateReview();
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
        setDraft(
          definition
            ? prepareEmployeeEditorDefinition(clone(definition), result.skills)
            : null,
        );
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
    if (busy) return;
    invalidateReview();
    skillSequence.current++;
    setSkillView(null);
    setSelectedId(employee.id);
    const definition =
      employee.currentDraft?.definition ??
      employee.currentPublished?.definition;
    setDraft(
      definition
        ? prepareEmployeeEditorDefinition(
            clone(definition),
            directory?.skills ?? [],
          )
        : null,
    );
    setMessage('');
    setError('');
    setTestRuns([]);
    setTrialTargets([]);
    setAuditEvents([]);
  }

  function update(path: string[], value: unknown) {
    invalidateReview();
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

  function selectSkills(values: string[]) {
    invalidateReview();
    setDraft((current) => {
      if (!current) return current;
      const explicit =
        current.capabilities.explicitToolNames ??
        current.capabilities.toolNames;
      return prepareEmployeeEditorDefinition(
        {
          ...current,
          capabilities: {
            ...current.capabilities,
            nativeSkillIds: values,
            explicitToolNames: explicit,
          },
        },
        directory?.skills ?? [],
      );
    });
  }

  function retainTool(name: string, retain: boolean) {
    invalidateReview();
    setDraft((current) => {
      if (!current) return current;
      const explicit =
        current.capabilities.explicitToolNames ??
        current.capabilities.toolNames;
      return prepareEmployeeEditorDefinition(
        {
          ...current,
          capabilities: {
            ...current.capabilities,
            explicitToolNames: retain
              ? [...new Set([...explicit, name])]
              : explicit.filter((tool) => tool !== name),
          },
        },
        directory?.skills ?? [],
      );
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
        body: JSON.stringify({
          definition: draft,
          expectedRevisionId: selected?.currentDraft?.id,
        }),
      });
      await load();
      if (!result.validation.valid) {
        setError(result.validation.errors.join('\n'));
        setMessage('草稿已保存，但配置检查未通过。请按提示修改对应配置。');
      } else {
        setMessage(
          result.validation.warnings.join('\n') ||
            '草稿已保存，员工配置检查通过。',
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
    if (!selectedId || !review?.valid || !confirmed || !review.packageChecksum)
      return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await api<{
        valid: boolean;
        errors: string[];
        revisionId: string;
        workspaceIds: string[];
        receipt: { companyCount: number; peopleCount: number };
      }>(`/api/v1/admin/platform-employees/${selectedId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          scope: 'assigned',
          expectedRevisionId: review.revisionId,
          expectedPublishedRevisionId: review.publishedRevisionId,
          expectedPackageChecksum: review.packageChecksum,
          policyVersions: review.policyVersions,
        }),
      });
      if (!result.valid) throw new Error(result.errors.join('\n'));
      setMessage(publicationMessage(result));
      await Promise.all([load(), loadAuditEvents(selectedId)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发布失败');
      void loadAuditEvents(selectedId).catch(() => undefined);
    } finally {
      invalidateReview();
      setBusy(false);
    }
  }

  async function publishAssigned() {
    if (!selectedId || !draft || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    invalidateReview();
    try {
      const saved = await api<{
        employee: Employee;
        validation: { valid: boolean; errors: string[] };
      }>(`/api/v1/admin/platform-employees/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          definition: draft,
          expectedRevisionId: selected?.currentDraft?.id,
        }),
      });
      // Keep the new draft/CAS baseline even if a subsequent publication fails.
      setDirectory((current) =>
        current
          ? {
              ...current,
              employees: current.employees.map((employee) =>
                employee.id === saved.employee.id ? saved.employee : employee,
              ),
            }
          : current,
      );
      if (saved.employee.currentDraft)
        setDraft(clone(saved.employee.currentDraft.definition));
      if (!saved.validation.valid)
        throw new Error(saved.validation.errors.join('\n'));
      const check = await api<PublicationReview>(
        `/api/v1/admin/platform-employees/${selectedId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ scope: 'assigned' }),
        },
      );
      if (!check.valid) throw new Error(check.errors.join('\n'));
      const result = await api<{
        valid: boolean;
        errors?: string[];
        workspaceIds: string[];
        receipt: { companyCount: number; peopleCount: number };
        trialTargets?: { workspaceId: string; employeeId: string }[];
      }>(`/api/v1/admin/platform-employees/${selectedId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          scope: 'assigned',
          expectedRevisionId: check.revisionId,
          expectedPublishedRevisionId: check.publishedRevisionId,
          expectedPackageChecksum: check.packageChecksum,
          policyVersions: check.policyVersions,
        }),
      });
      if (!result.valid)
        throw new Error(result.errors?.join('\n') ?? '发布失败');
      setMessage(publicationMessage(result));
      await Promise.all([load(), loadAuditEvents(selectedId)]);
      setTrialTargets(result.trialTargets ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发布失败');
    } finally {
      setBusy(false);
    }
  }

  async function preflight() {
    if (!selectedId || busy) return;
    const generation = ++reviewSequence.current;
    setReview(null);
    setConfirmed(false);
    setBusy(true);
    setError('');
    try {
      const result = await api<PublicationReview>(
        `/api/v1/admin/platform-employees/${selectedId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ scope: 'assigned' }),
        },
      );
      if (
        generation === reviewSequence.current &&
        result.employeeId === selectedId
      )
        setReview(result);
    } catch (e) {
      if (generation === reviewSequence.current)
        setError(e instanceof Error ? e.message : '预检失败');
    } finally {
      setBusy(false);
    }
  }

  async function inspectSkill(id: string) {
    const generation = ++skillSequence.current;
    setSkillView(null);
    try {
      const result = await api<{ skill: Record<string, unknown> }>(
        `/api/v1/admin/platform-skills/${id}`,
      );
      if (generation === skillSequence.current) setSkillView(result.skill);
    } catch (e) {
      if (generation === skillSequence.current)
        setError(e instanceof Error ? e.message : 'Skill 读取失败');
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
        body: JSON.stringify({
          definition: draft,
          expectedRevisionId: selected?.currentDraft?.id,
        }),
      });
      // Saving for a trial also advances the immutable draft revision. Keep
      // the editor's CAS baseline current even if compilation/trial fails.
      setDirectory((current) =>
        current
          ? {
              ...current,
              employees: current.employees.map((employee) =>
                employee.id === saved.employee.id ? saved.employee : employee,
              ),
            }
          : current,
      );
      if (saved.employee.currentDraft)
        setDraft(clone(saved.employee.currentDraft.definition));
      invalidateReview();
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
        `已保存草稿，测试任务已提交到${workspace ? `「${workspace.name}」` : '所选租户'}的环境。结果会显示在下方，租户正在使用的版本保持不变。`,
      );
      await loadTestRuns(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '草稿测试启动失败');
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
    if (
      !window.confirm(
        '将所有现有配发恢复到上一发布版本，个人增删和运行中的工作保持不变。是否继续？',
      )
    )
      return;
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
            expectedPublishedRevisionId: selected?.currentPublished?.id,
          }),
        },
      );
      setRollbackReason('');
      setMessage(
        `已回滚到发布 revision ${result.revision}，后续 Run 使用回退版本，运行中 Run 的冻结快照不变。`,
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
  const trialLinks = trialTargets.map((target) => {
    const workspace = directory.workspaces.find(
      (item) => item.id === target.workspaceId,
    );
    if (!workspace?.trialUrl) return null;
    const url = new URL(workspace.trialUrl);
    url.searchParams.set('employee', target.employeeId);
    return (
      <a
        className={styles.button}
        href={url.toString()}
        target="_blank"
        rel="noreferrer"
        key={target.workspaceId}
      >
        在 {workspace.organizationName} 真实试用此员工 →
      </a>
    );
  });

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
    const accent = resolveEmployeeAccent(
      draft.name,
      draft.appearance.accentColor,
    );
    panel = (
      <>
        <fieldset className={styles.employeeColors}>
          <legend>员工配色</legend>
          <p>科技十色。选择员工的识别色，保存并发布后同步到前台。</p>
          <div className={styles.colorOptions}>
            {(
              Object.entries(employeeColorPalette) as [
                EmployeePaletteColor,
                (typeof employeeColorPalette)[EmployeePaletteColor],
              ][]
            ).map(([id, color]) => (
              <label key={id} className={styles.colorOption}>
                <input
                  type="radio"
                  name="employee-accent-color"
                  value={id}
                  checked={accent === id}
                  onChange={() => update(['appearance', 'accentColor'], id)}
                />
                <span
                  className={styles.colorSwatch}
                  style={{
                    backgroundColor: color.value,
                    color: employeeColorForeground(id),
                  }}
                  aria-hidden="true"
                >
                  {accent === id ? '✓' : ''}
                </span>
                <span>{color.label}</span>
              </label>
            ))}
          </div>
          <div className={styles.colorPreview}>
            <span
              style={{
                backgroundColor: employeeColorPalette[accent].value,
                color: employeeColorForeground(accent),
              }}
              aria-hidden="true"
            >
              {draft.name.slice(0, 1)}
            </span>
            <div>
              <strong>{draft.name}</strong>
              <small>
                {employeeColorPalette[accent].label} · 前台识别色预览
              </small>
            </div>
          </div>
        </fieldset>
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
              <span>行为准则和工作边界</span>
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
          <p>
            员工名称来自「基础」，角色和使命在这里设置。“系统提示词”用于平台通用规则，请勿在其中重复指定员工名称，以免身份冲突。
          </p>
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
            <span>勾选技能自动添加所需工具，并生成技能目录和路由说明</span>
          </div>
          <div>
            <code>SKILL.md</code>
            <span>每个已选 Skill 作为独立、不可变的发布快照传入运行时</span>
          </div>
        </div>
        <p className={styles.muted}>
          取消技能会移除仅由它带入的工具；其他技能所需和手动保留的工具不受影响。历史配置中的工具继续保留。
        </p>
        {directory.skills.length ? (
          <Checks
            items={directory.skills.map((skill) => ({
              id: skill.id,
              label: employeeSkillLabel(skill),
              detail: `${skill.source === 'dsh-migrated' ? 'DSH 迁移' : 'AllRice 自有'} · v${skill.version} · ${skill.license} · ${skill.reviewStatus === 'reviewed' ? '已审核' : '未通过审核'}${skill.bundleChecksum ? ` · 冻结资源包 ${skill.resourceCount ?? 0} 项` : ''} · ${skill.description}`,
              disabled: !skill.enabled || skill.reviewStatus !== 'reviewed',
            }))}
            selected={draft.capabilities.nativeSkillIds}
            onChange={selectSkills}
          />
        ) : (
          <p className={styles.notice}>
            平台原生 Skill 库当前为空。先审核并迁移 Skill，再装配给 Rice。
          </p>
        )}
        <div className={styles.actions}>
          {directory.skills.map((skill) => (
            <button
              className={styles.button}
              key={skill.id}
              onClick={() => void inspectSkill(skill.id)}
            >
              查看 {employeeSkillLabel(skill)} 内容
            </button>
          ))}
        </div>
        {skillView ? (
          <section aria-label="Skill 只读内容">
            <h3>Skill 来源与内容（只读）</h3>
            <p>查看不执行，也不授予任何工具权限。</p>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify({ ...skillView, content: undefined }, null, 2)}
            </pre>
            <h4>原文</h4>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {String(skillView.content ?? '')}
            </pre>
          </section>
        ) : null}
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
              invalidateReview();
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
          onChange={(model) => {
            invalidateReview();
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
            });
          }}
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
          <GeminiCredentialSettings
            credentialReference={draft.modelPolicy.credentialReference}
          />
        ) : null}
        {draft.modelPolicy.provider === 'gemini' ? (
          <p className={`${styles.notice} ${styles.fieldWide}`}>
            Gemini 使用 Google API 密钥，独立于 Codex 订阅和 Gemini
            网页订阅计费。API Key
            使用上方独立按钮保存，员工模型配置仍需点击“保存草稿”。
          </p>
        ) : null}
      </div>
    );
  } else if (tab === 'tools') {
    panel = (
      <>
        <p>
          {directory.rapidIteration
            ? '勾选工具后保存并发布即可启用；所需的员工能力和执行策略会自动配置。'
            : '选择员工工具，保存并发布后生效。'}
        </p>
        <p className={styles.notice}>
          只需选择技能和工具，所需能力与本地文件访问方式会自动配置。
          是否自动执行，由使用者在前台「设置 → 员工工作方式」中决定。
        </p>
        <EmployeeToolTree
          definition={draft}
          skills={directory.skills}
          tools={
            directory.tools ??
            employeeToolCatalog.map((tool) => ({ ...tool, released: false }))
          }
          busy={busy}
          onSelectTool={retainTool}
          onManageSkills={() => setTab('skills')}
        />
        <details className={styles.muted}>
          <summary>配置帮助</summary>
          <p>
            {directory.rapidIteration
              ? '添加后保存并发布即可使用；草稿测试仅支持问答和读取资料，完整任务请进入租户工作台验证。'
              : '添加后保存草稿，按发布检查完成当前版本验证，再发布到目标租户。'}
          </p>
          <p>
            成员继承已派驻员工的能力，执行跟随设置中的“员工工作方式”。使用本地项目时，在“我的电脑”连接
            Bridge
            并选择项目目录，测试环境会自动准备；缺项可在“能力与环境”查看。
          </p>
        </details>
      </>
    );
  } else if (tab === 'debug') {
    panel = (
      <>
        <p className={styles.notice}>
          在这里测试当前草稿的回复效果，结果显示在下方。仅支持问答和读取资料，生成文件、修改数据等完整任务请发布后在租户工作台验证。
        </p>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span>测试使用的租户</span>
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
            <small>使用所选租户已连接的模型和工具进行测试。</small>
          ) : null}
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span>测试任务</span>
          <textarea
            value={testPrompt}
            onChange={(event) => setTestPrompt(event.target.value)}
          />
        </label>
        <div className={styles.testAction}>
          <button
            className={styles.button}
            data-primary="true"
            disabled={busy || !testPrompt.trim() || !previewWorkspaceId}
            onClick={() => void runDraftPreview()}
          >
            {busy ? '正在启动测试…' : '测试草稿'}
          </button>
          <span>自动保存草稿，不影响租户正在使用的版本。</span>
        </div>
        <section className={styles.publishEntry} aria-label="让租户使用">
          <div>
            <strong>让租户使用</strong>
            <p>到发布页选择租户并发布，然后进入工作台使用完整能力。</p>
          </div>
          <button
            className={styles.button}
            disabled={busy}
            onClick={() => {
              invalidateReview();
              if (previewWorkspaceId) setTab('publish');
            }}
          >
            前往发布
          </button>
        </section>
        <div className={styles.testRuns}>
          {testRuns.length === 0 ? (
            <p className={styles.muted}>还没有草稿测试记录。</p>
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
                    测试租户：
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
                · 已发布，可在组织管理中配发
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
          首次发布进入可配发目录，在组织管理中为员工配发。更新自动覆盖全部现有配发，个人增删保持不变；运行中的工作沿用原版本，现有会话的下一轮使用新版。
        </p>
        {directory.rapidIteration ? (
          <div className={styles.actions}>
            <button
              className={styles.button}
              data-primary="true"
              disabled={busy}
              onClick={() => void publishAssigned()}
            >
              {busy ? '正在保存并发布…' : '更新到租户'}
            </button>
            <p>
              更新会一并保存当前修改。尚未配发时只发布到 AI
              员工目录，不会自动配发给任何人。
            </p>
            {trialLinks}
          </div>
        ) : null}
        <button
          className={styles.button}
          disabled={
            busy ||
            JSON.stringify(draft) !==
              JSON.stringify(selected.currentDraft?.definition)
          }
          onClick={() => void preflight()}
        >
          查看发布检查与版本差异
        </button>
        {JSON.stringify(draft) !==
        JSON.stringify(selected.currentDraft?.definition) ? (
          <p>
            {directory.rapidIteration
              ? '有未保存的修改，点击“更新到租户”会一并保存。'
              : '有未保存的修改，请先保存草稿。'}
          </p>
        ) : null}
        {review ? (
          <section aria-label="发布预检">
            <h3>发布确认：{review.revisionId.slice(0, 8)}</h3>
            <p>
              目标：
              {review.targets
                .map(
                  (target) =>
                    `${target.organizationName} / ${target.name}（策略 v${target.version ?? '未配置'}）`,
                )
                .join('、')}
            </p>
            {review.errors.map((item, index) => (
              <p className={styles.error} key={`e${index}`}>
                {item}
              </p>
            ))}
            {review.warnings.map((item, index) => (
              <p className={styles.notice} key={`w${index}`}>
                {item}
              </p>
            ))}
            <details>
              <summary>
                查看与已发布版本的差异（{review.diff.length} 项）
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(review.diff, null, 2)}
              </pre>
            </details>
            {review.targets.map((target) => (
              <p key={target.id}>
                <a
                  href={`/runtime-console?view=tenants&organizationId=${target.organizationId}&workspaceId=${target.id}&tenantView=employees`}
                >
                  查看 {target.organizationName} / {target.name} 的 AI 员工团队
                  →
                </a>
              </p>
            ))}
            {!directory.rapidIteration && (
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy || !review.valid}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已确认版本差异、发布范围及尚未满足的运行条件
              </label>
            )}
          </section>
        ) : null}
        {!directory.rapidIteration && (
          <button
            className={styles.button}
            data-primary="true"
            disabled={busy || !review?.valid || !confirmed}
            onClick={() => void publish()}
          >
            {busy ? '发布中…' : '确认更新到租户'}
          </button>
        )}
        {error ? <p className={styles.error}>{error}</p> : null}
        {message ? <p className={styles.notice}>{message}</p> : null}
        <section className={styles.dangerZone}>
          <h3>回滚发布</h3>
          <p className={styles.muted}>
            将当前分配的全部租户恢复到上一个不可变发布快照；后续 Run
            使用回退版本，运行中的 Run 保持原快照，个人移除保持生效。
          </p>
          <Field
            label="回滚原因"
            value={rollbackReason}
            wide
            onChange={setRollbackReason}
          />
          <button
            className={styles.button}
            disabled={
              busy || !rollbackReason.trim() || !selected.currentPublished
            }
            onClick={() => void rollbackEmployee()}
          >
            回滚到上一发布
          </button>
        </section>
        <section className={styles.dangerZone}>
          <h3>停用员工</h3>
          <p className={styles.muted}>
            停用会撤回全部租户分配，不删除不可变版本和审计记录。重新发布进入目录，需在组织管理中重新配发。
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
              disabled={busy}
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
