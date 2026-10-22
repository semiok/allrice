'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Button,
  IconClockOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  AutomationCatalogSchema,
  AutomationCatalogHistorySchema,
  OnceTaskSchema,
  type AutomationCatalogTask,
  type ChangeRecurringTaskInput,
} from '@allrice/contracts';
import {
  clearRecurringIntent,
  parseRecurringIntent,
  recurringContent,
  recurringDraft,
  recurringStorageKey,
  resolveRecurringIntent,
  saveRecurringIntent,
  type RecurringTaskDraft,
  type RecurringTaskIntent,
} from './recurring-task-intent';
import native from './dsh-upstream/automation/TaskManagerPage.module.css';
import card from './dsh-upstream/automation/ScheduleCreateCard.module.css';
import css from './automation-tasks.module.css';
import { RecurringWeekdays } from './recurring-weekdays';

type Identity = {
  workspaceId: string;
  scope: string;
  headers: Record<string, string>;
};
export function automationStatus(entry: AutomationCatalogTask) {
  const d = entry.definition;
  const status = d.kind === 'legacy' ? d.status : d.task.status;
  const labels: Record<string, string> = {
    preparing: '准备中',
    enabled: '已启用',
    paused: '已暂停',
    deleting: '删除中',
    deleted: '已删除',
    pending: '待执行',
    queued: '排队中',
    running: '执行中',
    awaiting_input: '待你回复',
    succeeded: '已完成',
    failed: '执行失败',
    canceled: '已取消',
    not_executed: '未执行',
  };
  return labels[status] ?? status;
}
function active(entry: AutomationCatalogTask) {
  const d = entry.definition,
    status = d.kind === 'legacy' ? d.status : d.task.status;
  return [
    'preparing',
    'enabled',
    'pending',
    'queued',
    'running',
    'awaiting_input',
  ].includes(status);
}
export function automationFrequency(entry: AutomationCatalogTask) {
  const d = entry.definition;
  if (d.kind === 'once')
    return '一次性 · ' + time(d.task.runAt, d.task.timezone);
  const rule = d.kind === 'recurring' ? d.task.rule : null;
  if (rule?.kind === 'every')
    return rule.seconds % 3600 === 0
      ? `每 ${rule.seconds / 3600} 小时`
      : rule.seconds % 60 === 0
        ? `每 ${rule.seconds / 60} 分钟`
        : `每 ${rule.seconds} 秒`;
  if (rule?.kind === 'daily')
    return `每天 ${rule.time.endsWith(':00') ? rule.time.slice(0, 5) : rule.time} · ${rule.timezone}`;
  if (rule?.kind === 'weekly')
    return `每周${rule.weekdays.map((day) => '一二三四五六日'[day - 1]).join('、')} ${rule.time.endsWith(':00') ? rule.time.slice(0, 5) : rule.time} · ${rule.timezone}`;
  if (d.kind === 'legacy') {
    const s = d.schedule;
    if (s.frequency === 'once') return '一次性 · ' + time(s.runAt!, s.timezone);
    return (
      (s.frequency === 'daily'
        ? '每天'
        : s.frequency === 'weekly'
          ? `每周${'日一二三四五六'[s.weekday!]}`
          : `每月 ${s.monthDay} 日`) + ` ${s.time} · ${s.timezone}`
    );
  }
  return '';
}
function time(value: string, timezone?: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timezone ? { timeZone: timezone } : {}),
      timeZoneName: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}
async function read(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body === 'object' && body !== null && 'message' in body
        ? String(body.message)
        : '读取失败，请稍后重试。',
    );
  return body;
}
function useHeaders(headers: Record<string, string>) {
  const key = JSON.stringify(
    Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  return useMemo(() => JSON.parse(key) as [string, string][], [key]);
}

/** Flat catalog across employees and conversations. Host SQL owns its scope. */
export function AutomationTaskList(
  props: Identity & {
    sessionId?: string;
    employees: Array<{ id: string; name: string }>;
    selectedId?: string | null;
    onSelect: (task: AutomationCatalogTask) => void;
    onNew: () => void;
  },
) {
  const [query, setQuery] = useState(''),
    [employeeId, setEmployeeId] = useState('');
  const [filter, setFilter] = useState('all');
  const [result, setResult] = useState<{
    tasks: AutomationCatalogTask[];
    nextCursor: string | null;
  }>({ tasks: [], nextCursor: null });
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const credentials = useHeaders(props.headers);
  const request = useRef<AbortController | null>(null);
  const generation = JSON.stringify([
    props.scope,
    props.workspaceId,
    credentials,
    query,
    employeeId,
    props.sessionId,
  ]);
  const current = useRef(generation);
  current.current = generation;
  const load = useCallback(
    async (cursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError('');
      const qs = new URLSearchParams({
        workspaceId: props.workspaceId,
        ...(props.sessionId ? { sessionId: props.sessionId } : {}),
        ...(query ? { query } : {}),
        ...(employeeId ? { employeeId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      try {
        const response = await fetch('/api/v1/scheduled-tasks?' + qs, {
          headers: Object.fromEntries(credentials),
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = AutomationCatalogSchema.parse(await read(response));
        if (controller.signal.aborted || current.current !== generation) return;
        setResult((previous) => ({
          tasks: cursor
            ? [
                ...new Map(
                  [...previous.tasks, ...data.tasks].map((t) => [t.id, t]),
                ).values(),
              ]
            : data.tasks,
          nextCursor: data.nextCursor,
        }));
      } catch (cause) {
        if (!controller.signal.aborted && current.current === generation)
          setError(cause instanceof Error ? cause.message : '加载失败');
      } finally {
        if (!controller.signal.aborted && current.current === generation)
          setLoading(false);
      }
    },
    [
      props.workspaceId,
      props.sessionId,
      credentials,
      query,
      employeeId,
      generation,
    ],
  );
  useEffect(() => {
    setResult({ tasks: [], nextCursor: null });
    const timer = setTimeout(() => void load(), 180);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    const refresh = () => {
      if (
        document.visibilityState === 'visible' &&
        !request.current?.signal.aborted
      )
        void load();
    };
    window.addEventListener('allrice:automation-changed', refresh);
    return () =>
      window.removeEventListener('allrice:automation-changed', refresh);
  }, [load]);
  const tasks = result.tasks.filter(
    (t) =>
      (!props.sessionId || active(t)) &&
      (filter === 'all' || (filter === 'active' ? active(t) : !active(t))),
  );
  return (
    <section
      className={`${native.page} ${css.catalog}`}
      aria-label={props.sessionId ? '当前会话的定时任务' : '自动化任务'}
    >
      <div className={native.listPane}>
        <div className={native.pageScroll}>
          <div className={native.pageContent}>
            <header className={native.pageHeading}>
              <h1>{props.sessionId ? '当前会话的定时任务' : '自动化任务'}</h1>
              <div className={native.creationActions}>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  刷新
                </Button>
                {!props.sessionId && (
                  <Button size="sm" onClick={props.onNew}>
                    新的自动化任务
                  </Button>
                )}
              </div>
            </header>
            {!props.sessionId && (
              <p className={css.caption}>
                统一管理各位 AI 员工的任务。到期后由原会话中的员工执行。
              </p>
            )}
            {!props.sessionId && (
              <div className={native.filters}>
                <div className={native.filterTabs}>
                  {[
                    ['all', '全部'],
                    ['active', '进行中'],
                    ['inactive', '已暂停 / 已结束'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={filter === id}
                      className={`${native.filterTab} ${filter === id ? native.filterTabActive : ''}`}
                      onClick={() => setFilter(id!)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {!props.sessionId && (
                  <select
                    aria-label="筛选员工"
                    className={css.employeeFilter}
                    value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                  >
                    <option value="">所有员工</option>
                    {props.employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <label className={css.search}>
              <span aria-hidden>⌕</span>
              <input
                aria-label="搜索自动化任务"
                placeholder="搜索名称、工作内容或员工"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className={native.notice}>
                {error}
              </p>
            )}
            {loading && !result.tasks.length ? (
              <p role="status" className={native.empty}>
                正在加载任务…
              </p>
            ) : null}
            {!loading && !error && !tasks.length ? (
              <div className={native.empty}>
                <IconClockOutlineRegular size={24} />
                <h2>
                  {result.nextCursor
                    ? '当前已加载任务中没有匹配项'
                    : '没有匹配的自动化任务'}
                </h2>
                <p>在新的工作中说明时间和工作内容，即可创建任务。</p>
              </div>
            ) : null}
            <ul className={native.listRows}>
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className={`${native.row} ${css.row} ${props.selectedId === task.id ? native.selectedRow : ''} ${!active(task) ? native.endedRow : ''}`}
                    onClick={() => props.onSelect(task)}
                  >
                    <IconClockOutlineRegular
                      size={18}
                      className={native.rowGlyph}
                    />
                    <span className={native.rowContent}>
                      <span className={native.rowTitle}>{task.name}</span>
                      <span className={native.rowSummary}>
                        <span className={native.metadata}>
                          {task.employeeName}
                        </span>
                        <span className={native.metadata}>
                          {automationFrequency(task)}
                        </span>
                      </span>
                      <span className={native.rowSummary}>
                        {task.nextRunAt
                          ? '下次运行 ' + time(task.nextRunAt)
                          : automationStatus(task)}
                        {task.sourceArchived ? ' · 原会话已归档' : ''}
                      </span>
                    </span>
                    <span className={css.status}>{automationStatus(task)}</span>
                    <span aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
            {result.nextCursor && (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load(result.nextCursor!)}
              >
                {loading ? '正在加载…' : '加载更多'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Navigation/editing only; never starts another clock or mounts a native Host. */
export function AutomationTaskDetail(
  props: Identity & {
    taskId: string;
    active: boolean;
    onOpenSession: (id: string) => void;
  },
) {
  const credentials = useHeaders(props.headers);
  const identity = JSON.stringify([
    props.scope,
    props.workspaceId,
    props.taskId,
    credentials,
  ]);
  const headers = useMemo(() => Object.fromEntries(credentials), [credentials]);
  return <AutomationDetailBody key={identity} {...props} headers={headers} />;
}
function AutomationDetailBody({
  workspaceId,
  scope,
  headers,
  taskId,
  active: visible,
  onOpenSession,
}: Identity & {
  taskId: string;
  active: boolean;
  onOpenSession: (id: string) => void;
}) {
  const [detail, setDetail] = useState<ReturnType<
    typeof AutomationCatalogHistorySchema.parse
  > | null>(null);
  const [draft, setDraft] = useState<RecurringTaskDraft | null>(null);
  const [tab, setTab] = useState('rule'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [pending, setPending] = useState<RecurringTaskIntent | null>(null);
  const [restored, setRestored] = useState(false),
    [storageError, setStorageError] = useState('');
  const [confirm, setConfirm] = useState<'delete' | 'cancel' | null>(null);
  const [legacyDraft, setLegacyDraft] = useState({
    name: '',
    prompt: '',
    time: '09:00',
    timezone: 'Asia/Shanghai',
  });
  const [legacyUnknown, setLegacyUnknown] = useState(false);
  const mounted = useRef(true),
    controller = useRef<AbortController | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const task = detail?.task,
    definition = task?.definition;
  const nativeTask = definition?.kind === 'recurring' ? definition.task : null;
  const storageKey =
    task?.employeeId && task.sessionId
      ? recurringStorageKey(scope + '/' + task.employeeId, task.sessionId)
      : null;
  const url =
    '/api/v1/scheduled-tasks/' +
    encodeURIComponent(taskId) +
    '?workspaceId=' +
    encodeURIComponent(workspaceId);
  const load = useCallback(
    async (cursor?: string, replaceDraft = false) => {
      const data = AutomationCatalogHistorySchema.parse(
        await read(
          await fetch(
            url + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
            { headers, cache: 'no-store' },
          ),
        ),
      );
      if (!mounted.current) return;
      setDetail((previous) =>
        cursor && previous
          ? {
              ...data,
              occurrences: [
                ...new Map(
                  [...previous.occurrences, ...data.occurrences].map((o) => [
                    o.id,
                    o,
                  ]),
                ).values(),
              ],
            }
          : data,
      );
      if (replaceDraft) {
        setDraft(
          data.task.definition.kind === 'recurring'
            ? recurringDraft(data.task.definition.task)
            : null,
        );
        const legacy =
          data.task.definition.kind === 'legacy'
            ? data.task.definition.schedule
            : null;
        setLegacyDraft({
          name: data.task.name,
          prompt: data.task.prompt,
          time: legacy?.time ?? '09:00',
          timezone: legacy?.timezone ?? 'Asia/Shanghai',
        });
      }
      return data;
    },
    [url, headers],
  );
  // headers belongs to the keyed parent and is stable for this mount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void load(undefined, true).catch((e) => {
      if (!cancelled) setError(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, load]);
  useEffect(() => {
    if (!task || restored) return;
    if (definition?.kind !== 'recurring') {
      setRestored(true);
      return;
    }
    try {
      if (!storageKey) throw new Error('身份不完整，暂时不能修改。');
      const raw = sessionStorage.getItem(storageKey);
      const intent = raw ? parseRecurringIntent(raw, storageKey) : null;
      if (intent && intent.kind === 'change' && intent.taskId === taskId) {
        setPending(intent);
        setNotice('上次操作尚待确认，只读取结果，不会重复提交。');
      } else if (intent)
        throw new Error('该会话有另一项待确认操作，请先在原入口核对。');
      setRestored(true);
    } catch (e) {
      setStorageError(e instanceof Error ? e.message : '无法保存操作记录。');
    }
  }, [task, definition, restored, storageKey, taskId]);
  const settle = useCallback(
    async (intent: RecurringTaskIntent, response: Response) => {
      const body: unknown = await response.json();
      const result = resolveRecurringIntent(intent, {
        source: 'readback',
        status: response.status,
        body,
      });
      if (
        !mounted.current ||
        intent.kind !== 'change' ||
        pendingRef.current?.kind !== 'change' ||
        pendingRef.current.body.operationId !== intent.body.operationId
      )
        return;
      if (result.state === 'unconfirmed') {
        setNotice('操作结果待核实，请稍后检查；不会再次提交。');
        return;
      }
      if (result.state === 'pending') {
        setNotice('已保存，等待调度确认。');
        await load();
        return;
      }
      clearRecurringIntent(sessionStorage, intent);
      setPending(null);
      pendingRef.current = null;
      setNotice(
        result.outcome === 'rejected'
          ? (result.errorMessage ?? '任务已变化，请核对最新规则。')
          : '设置已更新。',
      );
      await load(undefined, true);
      window.dispatchEvent(new Event('allrice:automation-changed'));
    },
    [load],
  );
  const check = useCallback(async () => {
    const intent = pendingRef.current;
    if (
      !visible ||
      !intent ||
      intent.kind !== 'change' ||
      document.visibilityState !== 'visible'
    )
      return;
    try {
      await settle(
        intent,
        await fetch(url + '&operationId=' + intent.body.operationId, {
          headers,
          cache: 'no-store',
        }),
      );
    } catch {
      if (mounted.current)
        setNotice('暂时无法核实操作结果，待连接恢复后再检查。');
    }
  }, [visible, url, headers, settle]);
  useEffect(() => {
    if (!pending || !visible) return;
    void check();
    const timer = setInterval(() => void check(), 4000);
    return () => clearInterval(timer);
  }, [check, pending, visible]);
  const change = async (action: ChangeRecurringTaskInput['action']) => {
    if (
      !nativeTask ||
      !storageKey ||
      !task?.sessionId ||
      busy ||
      pendingRef.current ||
      !restored ||
      storageError
    )
      return;
    setError('');
    try {
      const content =
        action === 'update' ? recurringContent(draft!, nativeTask.rule) : null;
      const body: ChangeRecurringTaskInput =
        action === 'update'
          ? {
              action,
              operationId: crypto.randomUUID(),
              expectedRevision: nativeTask.revision,
              ...content!,
            }
          : {
              action,
              operationId: crypto.randomUUID(),
              expectedRevision: nativeTask.revision,
            };
      const intent: RecurringTaskIntent = {
        version: 1,
        kind: 'change',
        storageKey,
        sessionId: task.sessionId,
        taskId,
        body,
      };
      saveRecurringIntent(sessionStorage, intent);
      setPending(intent);
      pendingRef.current = intent;
      setBusy(true);
      setConfirm(null);
      // Exact write acknowledgement is verified by the same receipt checker.
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json();
      const result = resolveRecurringIntent(intent, {
        source: 'write',
        status: response.status,
        body: payload,
      });
      if (result.state === 'unconfirmed') {
        setNotice('操作结果待核实；不会重复提交。');
        return;
      }
      // Readback includes the exact original operation, including a rejection.
      await check();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作结果待核实。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const cancel = async () => {
    if (busy || legacyUnknown) return;
    setBusy(true);
    setConfirm(null);
    setError('');
    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const body = await read(response);
      const actual = OnceTaskSchema.parse((body as { task: unknown }).task);
      if (actual.id !== taskId) throw new Error('任务回执不匹配，请刷新核实。');
      setNotice(
        actual.status === 'canceled'
          ? '任务已取消。'
          : '任务已经派发，取消没有撤回本轮执行。',
      );
      await load();
      window.dispatchEvent(new Event('allrice:automation-changed'));
    } catch (e) {
      setLegacyUnknown(true);
      setError(
        (e instanceof Error ? e.message : '请求结果待核实') +
          ' 请刷新核实，不会自动重试。',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const legacyChange = async (
    action: 'update' | 'pause' | 'resume' | 'delete',
  ) => {
    if (busy || legacyUnknown || !task || definition?.kind !== 'legacy') return;
    setBusy(true);
    setError('');
    setConfirm(null);
    try {
      const content =
        action === 'update'
          ? {
              name: legacyDraft.name,
              prompt: legacyDraft.prompt,
              schedule: {
                ...definition.schedule,
                ...(definition.schedule.frequency !== 'once'
                  ? { time: legacyDraft.time }
                  : {}),
                timezone: legacyDraft.timezone,
              },
            }
          : {};
      await read(
        await fetch(url, {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            expectedRevision: definition.revision,
            ...content,
          }),
        }),
      );
      await load(undefined, true);
      setNotice('设置已更新。');
      window.dispatchEvent(new Event('allrice:automation-changed'));
    } catch (e) {
      setLegacyUnknown(true);
      setError(
        (e instanceof Error ? e.message : '请求结果待核实') +
          ' 请刷新核实，不会自动重试。',
      );
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = busy || !!pending || !restored || !!storageError;
  const editable = !!nativeTask?.canManage;
  const changed =
    !!nativeTask &&
    draft !== null &&
    JSON.stringify(draft) !== JSON.stringify(recurringDraft(nativeTask));
  if (!task)
    return (
      <div className={native.empty}>
        <p role={error ? 'alert' : 'status'}>{error || '正在加载任务…'}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void load(undefined, true).catch((e) => setError(e.message))
          }
        >
          重试
        </Button>
      </div>
    );
  const refresh = () =>
    void load(undefined, true)
      .then(() => {
        setLegacyUnknown(false);
        setError('');
      })
      .catch((e) => setError(e.message));
  const original = task.sessionId ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onOpenSession(task.sessionId!)}
    >
      打开原会话 ↗
    </Button>
  ) : null;
  return (
    <section className={css.detail} aria-label={'自动化任务详情：' + task.name}>
      <div className={native.detailTabsBar}>
        <div role="tablist" aria-label="任务详情" className={native.detailTabs}>
          {[
            ['rule', '规则'],
            ['history', '任务运行记录'],
          ].map(([id, label]) => (
            <button
              type="button"
              role="tab"
              key={id}
              className={native.detailTab}
              aria-selected={tab === id}
              onClick={() => setTab(id!)}
            >
              {label}
            </button>
          ))}
        </div>
        {original}
      </div>
      <div className={css.detailScroll}>
        <header>
          <div className={css.detailTitle}>
            <h2>{task.name}</h2>
            <span className={css.status}>{automationStatus(task)}</span>
          </div>
          <p className={css.caption}>
            {task.employeeName}
            {task.nextRunAt ? ' · 下次运行 ' + time(task.nextRunAt) : ''}
          </p>
        </header>
        {task.sourceArchived && (
          <p className={native.notice}>
            原会话已归档。仍可查看或停止任务；恢复执行前请先恢复原会话。
          </p>
        )}
        {error && (
          <p role="alert" className={css.error}>
            {error}
          </p>
        )}
        {storageError && (
          <p role="alert" className={css.error}>
            {storageError}
          </p>
        )}
        {notice && (
          <p role="status" className={native.notice}>
            {notice}
          </p>
        )}
        {pending && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void check()}
          >
            检查操作结果
          </Button>
        )}
        {tab === 'rule' ? (
          <>
            {nativeTask && draft ? (
              <form
                id={'automation-edit-' + taskId}
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  void change('update');
                }}
                className={css.form}
              >
                <label>
                  任务名称
                  <input
                    aria-label="任务名称"
                    maxLength={160}
                    disabled={!editable || disabled}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  工作内容
                  <textarea
                    aria-label="工作内容"
                    className={native.instruction}
                    rows={5}
                    maxLength={40000}
                    disabled={!editable || disabled}
                    value={draft.prompt}
                    onChange={(e) =>
                      setDraft({ ...draft, prompt: e.target.value })
                    }
                  />
                </label>
                <h3>运行时间</h3>
                <div className={css.rules}>
                  <label>
                    重复
                    <select
                      aria-label="重复"
                      disabled={!editable || disabled}
                      value={draft.kind}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          kind: e.target.value as RecurringTaskDraft['kind'],
                        })
                      }
                    >
                      <option value="every">每 N 分钟</option>
                      <option value="daily">每天</option>
                      <option value="weekly">每周</option>
                    </select>
                  </label>
                  {draft.kind === 'every' ? (
                    <label>
                      重复间隔
                      <span>
                        <input
                          aria-label="重复间隔（分钟）"
                          type="number"
                          min="1"
                          step="any"
                          disabled={!editable || disabled}
                          value={draft.minutes}
                          onChange={(e) =>
                            setDraft({ ...draft, minutes: e.target.value })
                          }
                        />{' '}
                        分钟
                      </span>
                    </label>
                  ) : (
                    <>
                      <label>
                        执行时间
                        <input
                          aria-label="执行时间"
                          type="time"
                          disabled={!editable || disabled}
                          value={draft.time}
                          onChange={(e) =>
                            setDraft({ ...draft, time: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        时区
                        <input
                          aria-label="时区"
                          disabled={!editable || disabled}
                          value={draft.timezone}
                          onChange={(e) =>
                            setDraft({ ...draft, timezone: e.target.value })
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
                {draft.kind === 'weekly' && (
                  <RecurringWeekdays
                    days={draft.weekdays}
                    disabled={!editable || disabled}
                    onChange={(weekdays) => setDraft({ ...draft, weekdays })}
                  />
                )}
                <p className={css.caption}>
                  {draft.kind === 'every'
                    ? '至少 1 分钟。间隔自任务创建或修改规则时起计，不受时区影响。'
                    : '按所选时区执行。夏令时跳过不存在的当地时间，重复时间只执行一次；停机后只处理最近一期。'}
                  {nativeTask.rule.kind !== 'every' &&
                  !nativeTask.rule.time.endsWith(':00')
                    ? '原时间含秒，未修改分钟时保留原秒数。'
                    : ''}
                </p>
              </form>
            ) : definition?.kind === 'legacy' ? (
              <div className={css.form}>
                <label>
                  任务名称
                  <input
                    aria-label="任务名称"
                    disabled={!definition.canManage || busy || legacyUnknown}
                    value={legacyDraft.name}
                    onChange={(e) =>
                      setLegacyDraft({ ...legacyDraft, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  工作内容
                  <textarea
                    aria-label="工作内容"
                    className={native.instruction}
                    disabled={!definition.canManage || busy || legacyUnknown}
                    value={legacyDraft.prompt}
                    onChange={(e) =>
                      setLegacyDraft({ ...legacyDraft, prompt: e.target.value })
                    }
                  />
                </label>
                <h3>运行时间</h3>
                <p>{automationFrequency(task)}</p>
                {definition.schedule.frequency !== 'once' && (
                  <label>
                    执行时间
                    <input
                      aria-label="执行时间"
                      type="time"
                      disabled={!definition.canManage || busy || legacyUnknown}
                      value={legacyDraft.time}
                      onChange={(e) =>
                        setLegacyDraft({ ...legacyDraft, time: e.target.value })
                      }
                    />
                  </label>
                )}
                <label>
                  时区
                  <input
                    aria-label="时区"
                    disabled={!definition.canManage || busy || legacyUnknown}
                    value={legacyDraft.timezone}
                    onChange={(e) =>
                      setLegacyDraft({
                        ...legacyDraft,
                        timezone: e.target.value,
                      })
                    }
                  />
                </label>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!definition.canManage || busy || legacyUnknown}
                  onClick={() => void legacyChange('update')}
                >
                  保存修改
                </Button>
              </div>
            ) : (
              <div className={css.form}>
                <h3>工作内容</h3>
                <p className={native.readonlyPrompt}>{task.prompt}</p>
                <h3>运行时间</h3>
                <p>{automationFrequency(task)}</p>
                <p className={css.caption}>
                  一次性任务可取消；如需调整时间，请在原会话重新安排。
                </p>
              </div>
            )}
            <div className={css.management}>
              {nativeTask && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    disabled ||
                    (nativeTask.status === 'paused'
                      ? !nativeTask.canManage
                      : !task.canStop)
                  }
                  onClick={() =>
                    void change(
                      nativeTask.status === 'paused' ? 'resume' : 'pause',
                    )
                  }
                >
                  {nativeTask.status === 'paused' ? '恢复任务' : '暂停任务'}
                </Button>
              )}
              {definition?.kind === 'legacy' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!definition.canManage || busy || legacyUnknown}
                  onClick={() =>
                    void legacyChange(
                      definition.status === 'paused' ? 'resume' : 'pause',
                    )
                  }
                >
                  {definition.status === 'paused' ? '恢复任务' : '暂停任务'}
                </Button>
              )}
              {task.canStop && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    busy || !!pending || legacyUnknown || !!storageError
                  }
                  onClick={() =>
                    setConfirm(
                      definition?.kind === 'once' ? 'cancel' : 'delete',
                    )
                  }
                >
                  {definition?.kind === 'once' ? '取消任务' : '删除任务'}
                </Button>
              )}
            </div>
            {confirm && (
              <div
                role="alertdialog"
                aria-label="确认停止任务"
                aria-modal="false"
                className={css.confirm}
              >
                <p>
                  {confirm === 'delete'
                    ? '删除后不再触发，已有运行记录保留。'
                    : '取消尚未派发的任务；已派发的本轮工作不会撤回。'}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirm(null)}
                >
                  返回
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void (confirm === 'cancel'
                      ? cancel()
                      : definition?.kind === 'legacy'
                        ? legacyChange('delete')
                        : change('delete'))
                  }
                >
                  确认{confirm === 'cancel' ? '取消' : '删除'}
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className={native.detailRecords}>
            {!detail.occurrences.length && (
              <p className={css.caption}>
                暂无运行记录。创建成功不代表已执行。
              </p>
            )}
            {detail.occurrences.map((o) => (
              <article key={o.id} className={native.delivery}>
                <IconClockOutlineRegular
                  size={16}
                  className={native.deliveryGlyph}
                />
                <div className={native.deliveryBody}>
                  <time className={native.deliveryTime}>
                    {time(o.scheduledAt)}
                  </time>
                  <p className={css.caption}>
                    {
                      {
                        pending: '待派发',
                        queued: '排队中',
                        running: '执行中',
                        awaiting_input: '待你回复',
                        succeeded: '已完成',
                        failed: '执行失败',
                        canceled: '已取消',
                        not_executed: '未执行',
                      }[o.status]
                    }
                  </p>
                  {o.errorMessage && (
                    <p className={css.error}>{o.errorMessage}</p>
                  )}
                  {o.runId && o.sessionId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpenSession(o.sessionId!)}
                    >
                      查看本轮结果 ↗
                    </Button>
                  )}
                </div>
              </article>
            ))}
            {detail.nextCursor && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void load(detail.nextCursor!).catch((e) =>
                    setError(e.message),
                  )
                }
              >
                更多运行记录
              </Button>
            )}
          </div>
        )}
      </div>
      <footer className={native.saveFooter}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={refresh}>
          刷新状态
        </Button>
        {tab === 'rule' && editable && changed && (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => setDraft(recurringDraft(nativeTask!))}
            >
              放弃修改
            </Button>
            <Button
              size="sm"
              type="submit"
              form={'automation-edit-' + taskId}
              disabled={disabled}
            >
              保存修改
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}

/** The caller supplies a task obtained from the authenticated task catalog. */
export function AutomationTaskCard({
  task,
  onOpen,
}: {
  task: AutomationCatalogTask;
  onOpen: () => void;
}) {
  return (
    <div className={card.card} data-tool="schedule_create">
      <button
        type="button"
        className={card.cardOpen}
        aria-label={'打开自动化任务：' + task.name}
        onClick={onOpen}
      />
      <div className={card.row}>
        <span className={card.leading}>
          <IconClockOutlineRegular size={18} />
        </span>
        <span className={card.body}>
          <span className={card.title}>{task.name}</span>
          <span className={card.frequency}>
            {automationFrequency(task)} · {automationStatus(task)}
          </span>
        </span>
        <Button
          variant="outline"
          size="sm"
          className={card.openButton}
          onClick={onOpen}
        >
          打开
        </Button>
      </div>
    </div>
  );
}

/** One authorized catalog read supplies all row markers and the current-session
 * entry. It neither starts a clock nor opens or activates any conversation. */
export function useSessionAutomations(
  input: Identity & { enabled: boolean; refreshKey: string },
) {
  const credentials = useHeaders(input.headers);
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    key: string;
    tasks: AutomationCatalogTask[];
  } | null>(null);
  const key = JSON.stringify([input.scope, input.workspaceId, credentials]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setRevision((n) => n + 1);
    };
    window.addEventListener('allrice:automation-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('allrice:automation-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  useEffect(() => {
    if (!input.enabled || !input.workspaceId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        let cursor: string | null = null;
        const tasks: AutomationCatalogTask[] = [],
          seen = new Set<string>();
        do {
          const qs = new URLSearchParams({
            workspaceId: input.workspaceId,
            ...(cursor ? { cursor } : {}),
          });
          const page = AutomationCatalogSchema.parse(
            await read(
              await fetch('/api/v1/scheduled-tasks?' + qs, {
                headers: Object.fromEntries(credentials),
                cache: 'no-store',
                signal: controller.signal,
              }),
            ),
          );
          tasks.push(...page.tasks.filter(active));
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor))
            throw Error('INVALID_AUTOMATION_CURSOR');
          if (cursor) seen.add(cursor);
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) setSnapshot({ key, tasks });
      })().catch(() => {
        if (!controller.signal.aborted) setSnapshot(null);
      });
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    key,
    input.enabled,
    input.workspaceId,
    credentials,
    input.refreshKey,
    revision,
  ]);
  return snapshot?.key === key ? snapshot.tasks : [];
}
