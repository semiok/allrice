'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ChangeRecurringTaskInputSchema,
  RecurringTaskHistorySchema,
  RecurringTaskListSchema,
  type ChangeRecurringTaskInput,
  type RecurringOccurrence,
  type RecurringTask,
} from '@allrice/contracts';
import {
  clearRecurringIntent,
  mergeRecurringTasks,
  parseRecurringIntent,
  recurringContent,
  recurringDraft,
  recurringIntentURL,
  recurringStorageKey,
  resolveRecurringIntent,
  saveRecurringIntent,
  type RecurringIntentResult,
  type RecurringTaskDraft,
  type RecurringTaskIntent,
} from './recurring-task-intent';
import css from './recurring-tasks.module.css';
import { RecurringWeekdays } from './recurring-weekdays';

type Props = {
  sessionId: string;
  /** Stable organization/workspace/viewer/AI UUIDs, separated by '/'. */
  scope: string;
  headers: Record<string, string>;
  onOpenSession: (id: string) => void;
};
type Lane = 'list' | 'history' | 'exact' | 'write';
type Action = Exclude<ChangeRecurringTaskInput['action'], 'update'>;
type Pager = { cursor: string | null; expanded: boolean; seen: Set<string> };
const pager = (): Pager => ({ cursor: null, expanded: false, seen: new Set() });
const taskLabels: Record<RecurringTask['status'], string> = {
  preparing: '准备中',
  enabled: '已启用',
  paused: '已暂停',
  deleting: '删除中',
  deleted: '已删除',
  failed: '准备失败',
};
const occurrenceLabels: Record<RecurringOccurrence['status'], string> = {
  pending: '待派发',
  queued: '排队中',
  running: '执行中',
  awaiting_input: '待你回复',
  succeeded: '已完成',
  failed: '执行失败',
  canceled: '已取消',
  not_executed: '未执行',
};
const actionLabels: Record<Action, string> = {
  pause: '暂停',
  resume: '恢复',
  delete: '删除',
};

function ruleLabel(task: RecurringTask): string {
  const rule = task.rule;
  if (rule.kind === 'daily')
    return `每天 ${rule.time.endsWith(':00') ? rule.time.slice(0, 5) : rule.time} · ${rule.timezone}`;
  if (rule.kind === 'weekly')
    return `每周${rule.weekdays.map((day) => '一二三四五六日'[day - 1]).join('、')} ${rule.time.endsWith(':00') ? rule.time.slice(0, 5) : rule.time} · ${rule.timezone}`;
  return rule.seconds % 60 === 0
    ? `每 ${rule.seconds / 60} 分钟`
    : `每 ${Math.floor(rule.seconds / 60)} 分 ${rule.seconds % 60} 秒`;
}

function timeLabel(value: string, task?: RecurringTask): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
      ...(task && task.rule.kind !== 'every'
        ? { timeZone: task.rule.timezone }
        : {}),
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function RecurringTasksPanel(props: Props) {
  const headerKey = JSON.stringify(
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(headerKey)) as Record<string, string>,
    [headerKey],
  );
  // Credential changes invalidate in-flight work but never enter sessionStorage.
  return (
    <RecurringTasksContent
      key={JSON.stringify([props.scope, props.sessionId, headerKey])}
      {...props}
      headers={headers}
      storageKey={recurringStorageKey(props.scope, props.sessionId)}
    />
  );
}

function RecurringTasksContent({
  sessionId,
  headers,
  onOpenSession,
  storageKey,
}: Props & { storageKey: string | null }) {
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const active = useRef(false);
  const controllers = useRef(new Map<Lane, AbortController>());
  const pendingRef = useRef<RecurringTaskIntent | null>(null);
  const listPager = useRef(pager());
  const historyPager = useRef(pager());
  const selected = useRef<string | null>(null);
  const [list, setList] = useState<{
    tasks: RecurringTask[];
    enabled: boolean | null;
    loading: boolean;
    more: boolean;
    error: string;
  }>({ tasks: [], enabled: null, loading: false, more: false, error: '' });
  const [history, setHistory] = useState<{
    task: RecurringTask | null;
    occurrences: RecurringOccurrence[];
    loading: boolean;
    more: boolean;
    error: string;
  }>({ task: null, occurrences: [], loading: false, more: false, error: '' });
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [pending, setPending] = useState<RecurringTaskIntent | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState({ text: '', error: false });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringTask | null>(null);
  const [draft, setDraft] = useState<RecurringTaskDraft>(() =>
    recurringDraft(),
  );
  const [formError, setFormError] = useState('');
  const [confirmation, setConfirmation] = useState<{
    task: RecurringTask;
    action: Action;
  } | null>(null);
  const formId = useId();
  const url =
    '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/schedule-tasks';

  const visible = useCallback(() => {
    const element = root.current;
    return (
      document.visibilityState === 'visible' &&
      !!element?.isConnected &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[hidden], [aria-hidden="true"], [inert]')
    );
  }, []);

  const abort = useCallback((lane?: Lane) => {
    if (lane) {
      controllers.current.get(lane)?.abort();
      controllers.current.delete(lane);
    } else {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    }
  }, []);

  const request = useCallback(
    (lane: Lane) => {
      if (
        !mounted.current ||
        !active.current ||
        !visible() ||
        controllers.current.has(lane)
      )
        return null;
      const controller = new AbortController();
      controllers.current.set(lane, controller);
      return {
        signal: controller.signal,
        current: () =>
          mounted.current &&
          active.current &&
          visible() &&
          controllers.current.get(lane) === controller &&
          !controller.signal.aborted,
        finish: () => {
          if (controllers.current.get(lane) === controller)
            controllers.current.delete(lane);
        },
      };
    },
    [visible],
  );

  useEffect(() => {
    mounted.current = true;
    try {
      if (!storageKey) throw new Error('scope unavailable');
      const raw = sessionStorage.getItem(storageKey);
      const restored =
        raw === null ? null : parseRecurringIntent(raw, storageKey);
      pendingRef.current = restored;
      setPending(restored);
      setStorageReady(true);
      if (restored)
        setNotice({
          text: '已保留上次请求，只会按原请求读取结果，不会重复提交。',
          error: true,
        });
    } catch {
      setStorageError(
        storageKey
          ? '无法读取待确认请求，暂时不能提交；已有任务仍可查看。'
          : '当前账号和AI身份尚未完整，暂时不能提交任务。',
      );
    }
    return () => {
      mounted.current = false;
      active.current = false;
      abort();
    };
  }, [storageKey, abort]);

  const accept = useCallback(
    (intent: RecurringTaskIntent, result: RecurringIntentResult) => {
      if (pendingRef.current !== intent || result.state === 'unconfirmed')
        return false;
      const task = result.task;
      if (task)
        setList((previous) => ({
          ...previous,
          tasks: mergeRecurringTasks([task], previous.tasks),
        }));
      if (result.state === 'pending') {
        setNotice({
          text: '操作已接收，正在确认应用结果；不会再次提交。',
          error: false,
        });
        return false;
      }
      try {
        clearRecurringIntent(sessionStorage, intent);
      } catch {
        setStorageReady(false);
        setStorageError(
          '结果已读取，但无法保存确认状态，请继续读取原请求结果。',
        );
        return false;
      }
      pendingRef.current = null;
      setPending(null);
      setStorageReady(true);
      setStorageError('');
      abort('list');
      abort('history');
      setList((previous) => ({ ...previous, loading: false }));
      setHistory((previous) => ({ ...previous, loading: false }));
      setConfirmation(null);
      setEditing(null);
      setFormOpen(false);
      setFormError('');
      if (result.outcome === 'created') setDraft(recurringDraft());
      setNotice({
        text:
          result.outcome === 'rejected'
            ? `${result.errorMessage || '操作未应用。'}${result.task ? ` 当前版本为 ${result.task.revision}。` : ''}请重新选择任务后操作。`
            : result.outcome === 'created'
              ? '周期任务已创建。'
              : '操作已应用。',
        error: result.outcome === 'rejected',
      });
      return true;
    },
    [abort],
  );

  const readList = useCallback(
    async (mode: 'refresh' | 'reset' | 'more' = 'refresh') => {
      if (mode === 'reset') {
        abort('list');
        listPager.current = pager();
      }
      const cursor = mode === 'more' ? listPager.current.cursor : null;
      if (mode === 'more' && cursor === null) return;
      const read = request('list');
      if (!read) return;
      setList((previous) => ({ ...previous, loading: true, error: '' }));
      try {
        const response = await fetch(
          url + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
          {
            headers,
            credentials: 'same-origin',
            cache: 'no-store',
            signal: read.signal,
          },
        );
        if (!read.current()) return;
        if ([401, 403, 404].includes(response.status)) {
          abort('history');
          selected.current = null;
          setHistoryId(null);
          listPager.current = pager();
          setList({
            tasks: [],
            enabled: false,
            more: false,
            loading: false,
            error: '当前暂时无法查看周期任务，请确认会话权限。',
          });
          return;
        }
        if (!response.ok) throw new Error('list unavailable');
        const result = RecurringTaskListSchema.parse(await response.json());
        if (!read.current()) return;
        if (
          result.tasks.some((task) => task.sessionId !== sessionId) ||
          new Set(result.tasks.map((task) => task.id)).size !==
            result.tasks.length ||
          (cursor !== null &&
            (result.nextCursor === cursor ||
              (result.nextCursor !== null &&
                listPager.current.seen.has(result.nextCursor))))
        )
          throw new Error('list identity or cursor changed');
        if (cursor !== null) {
          listPager.current.expanded = true;
          listPager.current.seen.add(cursor);
        }
        if (mode === 'more' || !listPager.current.expanded)
          listPager.current.cursor = result.nextCursor;
        const expanded = listPager.current.expanded;
        const ids = new Set(result.tasks.map((task) => task.id));
        setList((previous) => ({
          tasks: mergeRecurringTasks(
            result.tasks,
            expanded
              ? previous.tasks
              : previous.tasks.filter((task) => ids.has(task.id)),
          ),
          enabled: result.enabled,
          loading: false,
          more: listPager.current.cursor !== null,
          error: '',
        }));
      } catch {
        if (read.current())
          setList((previous) => ({
            ...previous,
            loading: false,
            error: '列表暂时无法加载；分页失效时请从头刷新。',
          }));
      } finally {
        read.finish();
      }
    },
    [abort, headers, request, sessionId, url],
  );

  const readHistory = useCallback(
    async (more = false) => {
      const taskId = selected.current;
      if (!taskId) return;
      const cursor = more ? historyPager.current.cursor : null;
      if (more && cursor === null) return;
      const read = request('history');
      if (!read) return;
      const current = () => read.current() && selected.current === taskId;
      setHistory((previous) => ({ ...previous, loading: true, error: '' }));
      try {
        const response = await fetch(
          url +
            '/' +
            encodeURIComponent(taskId) +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
          {
            headers,
            credentials: 'same-origin',
            cache: 'no-store',
            signal: read.signal,
          },
        );
        if (!current()) return;
        if (!response.ok) throw new Error('history unavailable');
        const result = RecurringTaskHistorySchema.parse(await response.json());
        if (!current()) return;
        if (
          result.task.id !== taskId ||
          result.task.sessionId !== sessionId ||
          result.occurrences.some((item) => item.taskId !== taskId) ||
          new Set(result.occurrences.map((item) => item.id)).size !==
            result.occurrences.length ||
          (cursor !== null &&
            (result.nextCursor === cursor ||
              (result.nextCursor !== null &&
                historyPager.current.seen.has(result.nextCursor))))
        )
          throw new Error('history identity or cursor changed');
        if (cursor !== null) {
          historyPager.current.expanded = true;
          historyPager.current.seen.add(cursor);
        }
        if (more || !historyPager.current.expanded)
          historyPager.current.cursor = result.nextCursor;
        const expanded = historyPager.current.expanded;
        setHistory((previous) => {
          const entries = new Map(
            result.occurrences.map((item) => [item.id, item]),
          );
          if (expanded)
            for (const item of previous.occurrences)
              if (!entries.has(item.id)) entries.set(item.id, item);
          return {
            task: result.task,
            occurrences: [...entries.values()],
            loading: false,
            more: historyPager.current.cursor !== null,
            error: '',
          };
        });
        setList((previous) => ({
          ...previous,
          tasks: mergeRecurringTasks([result.task], previous.tasks),
        }));
      } catch {
        if (current())
          setHistory((previous) => ({
            ...previous,
            loading: false,
            error: '执行记录暂时无法读取，请刷新后重试。',
          }));
      } finally {
        read.finish();
      }
    },
    [headers, request, sessionId, url],
  );

  const reconcile = useCallback(async () => {
    const intent = pendingRef.current;
    if (!intent || controllers.current.has('write')) return;
    const read = request('exact');
    if (!read) return;
    const current = () => read.current() && pendingRef.current === intent;
    setChecking(true);
    try {
      const response = await fetch(recurringIntentURL(intent), {
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: read.signal,
      });
      const body: unknown = await response.json();
      if (!current()) return;
      const result = resolveRecurringIntent(intent, {
        source: 'readback',
        status: response.status,
        body,
      });
      if (result.state === 'unconfirmed') {
        setNotice({
          text: [401, 403].includes(response.status)
            ? '当前权限暂时无法确认结果，原请求仍保留；不会重复提交。'
            : '尚未确认原请求结果，请稍后继续读取；不会重复提交。',
          error: true,
        });
      } else accept(intent, result);
    } catch {
      if (current())
        setNotice({
          text: '读取结果暂时失败，原请求仍保留；不会重复提交。',
          error: true,
        });
    } finally {
      if (read.current()) setChecking(false);
      read.finish();
    }
  }, [accept, headers, request]);

  useEffect(() => {
    const stop = () => {
      active.current = false;
      abort();
      if (mounted.current) {
        setBusy(false);
        setChecking(false);
        setList((previous) => ({ ...previous, loading: false }));
        setHistory((previous) => ({ ...previous, loading: false }));
      }
    };
    const tick = () => {
      if (!visible()) {
        if (active.current) stop();
        return;
      }
      active.current = true;
      void readList();
      void reconcile();
      void readHistory();
    };
    const changed = () => {
      const next = visible();
      if (!next) stop();
      else if (!active.current) tick();
    };
    document.addEventListener('visibilitychange', changed);
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(changed);
    if (root.current) resize?.observe(root.current);
    const mutation =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(changed);
    for (
      let node: HTMLElement | null = root.current;
      node;
      node = node.parentElement
    )
      mutation?.observe(node, {
        attributes: true,
        attributeFilter: ['hidden', 'aria-hidden', 'class', 'style', 'inert'],
      });
    const timer = setInterval(tick, 10_000);
    changed();
    return () => {
      clearInterval(timer);
      resize?.disconnect();
      mutation?.disconnect();
      document.removeEventListener('visibilitychange', changed);
      stop();
    };
  }, [abort, readHistory, readList, reconcile, visible]);

  const send = useCallback(
    async (intent: RecurringTaskIntent) => {
      if (
        !storageReady ||
        !storageKey ||
        pendingRef.current ||
        controllers.current.has('write') ||
        !active.current ||
        !visible()
      )
        return;
      try {
        saveRecurringIntent(sessionStorage, intent);
      } catch {
        setStorageReady(false);
        setStorageError('无法保存原请求，尚未发送。请恢复会话存储后再操作。');
        return;
      }
      pendingRef.current = intent;
      setPending(intent);
      abort('list');
      abort('history');
      abort('exact');
      setList((previous) => ({ ...previous, loading: false }));
      setHistory((previous) => ({ ...previous, loading: false }));
      const write = request('write');
      if (!write) return; // The persisted intent remains unknown if visibility changed.
      setBusy(true);
      setChecking(false);
      setNotice({ text: '', error: false });
      try {
        const response = await fetch(
          url +
            (intent.kind === 'change'
              ? '/' + encodeURIComponent(intent.taskId)
              : ''),
          {
            method: intent.kind === 'create' ? 'POST' : 'PATCH',
            headers: { ...headers, 'content-type': 'application/json' },
            credentials: 'same-origin',
            signal: write.signal,
            body: JSON.stringify(intent.body),
          },
        );
        const body: unknown = await response.json();
        if (!write.current() || pendingRef.current !== intent) return;
        const result = resolveRecurringIntent(intent, {
          source: 'write',
          status: response.status,
          body,
        });
        if (result.state === 'unconfirmed')
          setNotice({
            text: '提交结果尚未确认，原请求已保存；接下来只读取结果。',
            error: true,
          });
        else accept(intent, result);
      } catch {
        if (write.current())
          setNotice({
            text: '提交结果尚未确认，原请求已保存；不会重复提交。',
            error: true,
          });
      } finally {
        if (write.current()) setBusy(false);
        write.finish();
        if (mounted.current && active.current && pendingRef.current === intent)
          void reconcile();
      }
    },
    [
      abort,
      accept,
      headers,
      reconcile,
      request,
      storageKey,
      storageReady,
      url,
      visible,
    ],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    if (!storageKey || pendingRef.current) return;
    try {
      const content = recurringContent(draft, editing?.rule);
      if (editing) {
        const latest = list.tasks.find((task) => task.id === editing.id);
        if (!latest?.canManage || latest.revision !== editing.revision)
          throw new Error('任务状态已变化，请重新选择编辑。');
        const body = ChangeRecurringTaskInputSchema.parse({
          action: 'update',
          operationId: crypto.randomUUID(),
          expectedRevision: editing.revision,
          ...content,
        });
        void send({
          version: 1,
          storageKey,
          sessionId,
          kind: 'change',
          taskId: editing.id,
          body,
        });
      } else if (list.enabled) {
        void send({
          version: 1,
          storageKey,
          sessionId,
          kind: 'create',
          body: { clientRequestId: crypto.randomUUID(), ...content },
        });
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '请检查填写内容。');
    }
  };

  const confirm = () => {
    if (!confirmation || !storageKey || pendingRef.current) return;
    const { task, action } = confirmation;
    const latest = list.tasks.find((item) => item.id === task.id);
    if (!latest?.canManage || latest.revision !== task.revision) {
      setConfirmation(null);
      setNotice({ text: '任务状态已变化，请重新选择操作。', error: true });
      return;
    }
    try {
      const body = ChangeRecurringTaskInputSchema.parse({
        action,
        operationId: crypto.randomUUID(),
        expectedRevision: task.revision,
      });
      void send({
        version: 1,
        storageKey,
        sessionId,
        kind: 'change',
        taskId: task.id,
        body,
      });
    } catch {
      setNotice({ text: '无法准备本次操作，请刷新后重新选择。', error: true });
    }
  };

  const openHistory = (task: RecurringTask) => {
    abort('history');
    selected.current = task.id;
    historyPager.current = pager();
    setHistoryId(task.id);
    setHistory({
      task,
      occurrences: [],
      more: false,
      loading: false,
      error: '',
    });
    void readHistory();
  };
  const locked = busy || pending !== null || !storageReady;
  const latestEditing =
    editing && list.tasks.find((task) => task.id === editing.id);
  const staleEditing =
    !!editing &&
    (!latestEditing?.canManage || latestEditing.revision !== editing.revision);
  const updateDraft = (patch: Partial<RecurringTaskDraft>) =>
    setDraft((previous) => ({ ...previous, ...patch }));

  return (
    <section className={css.panel} ref={root} aria-label="周期任务">
      <div className={css.heading}>
        <strong>周期任务</strong>
        <button
          type="button"
          disabled={locked || !list.enabled}
          onClick={() => {
            setEditing(null);
            setDraft(recurringDraft());
            setFormError('');
            setFormOpen(true);
            setConfirmation(null);
          }}
        >
          新建周期任务
        </button>
      </div>
      <p className={css.hint}>
        由当前AI在这个会话中执行。暂停期间不执行，恢复从下一期开始；已排队的任务可继续。
      </p>
      {storageError && (
        <p className={css.error} role="alert">
          {storageError}
        </p>
      )}
      {pending && (
        <div className={css.pending} role="status">
          <strong>请求待确认</strong>
          <p>原请求已保存，确认前不会再次提交。</p>
          <button
            type="button"
            disabled={busy || checking}
            onClick={() => void reconcile()}
          >
            {checking ? '正在读取…' : '按原请求读取结果'}
          </button>
        </div>
      )}
      {notice.text && (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? css.error : css.notice}
        >
          {notice.text}
        </p>
      )}
      {formOpen && (
        <form
          className={css.form}
          onSubmit={submit}
          aria-label={editing ? '编辑周期任务' : '创建周期任务'}
        >
          <div className={css.heading}>
            <strong>
              {editing ? `编辑 · 版本 ${editing.revision}` : '创建周期任务'}
            </strong>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setEditing(null);
              }}
              disabled={busy}
            >
              关闭
            </button>
          </div>
          <label>
            名称
            <input
              value={draft.name}
              maxLength={160}
              required
              disabled={locked}
              onChange={(event) => updateDraft({ name: event.target.value })}
            />
          </label>
          <label>
            执行内容
            <textarea
              value={draft.prompt}
              maxLength={40_000}
              required
              rows={3}
              disabled={locked}
              onChange={(event) => updateDraft({ prompt: event.target.value })}
            />
          </label>
          <label>
            执行周期
            <select
              value={draft.kind}
              disabled={locked}
              onChange={(event) =>
                updateDraft({
                  kind: event.target.value as RecurringTaskDraft['kind'],
                })
              }
            >
              <option value="every">每隔一段时间</option>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {draft.kind === 'every' ? (
            <label>
              间隔分钟
              <input
                type="number"
                min="1"
                max="525600"
                step="any"
                required
                value={draft.minutes}
                disabled={locked}
                onChange={(event) =>
                  updateDraft({ minutes: event.target.value })
                }
              />
            </label>
          ) : (
            <div className={css.daily}>
              <label>
                {draft.kind === 'weekly' ? '执行时间' : '每天时间'}
                <input
                  type="time"
                  step="60"
                  required
                  value={draft.time}
                  disabled={locked}
                  onChange={(event) =>
                    updateDraft({ time: event.target.value })
                  }
                />
              </label>
              <label>
                IANA时区
                <input
                  required
                  maxLength={64}
                  list={formId + '-zones'}
                  value={draft.timezone}
                  disabled={locked}
                  onChange={(event) =>
                    updateDraft({ timezone: event.target.value })
                  }
                  placeholder="Asia/Shanghai"
                />
                <datalist id={formId + '-zones'}>
                  {[
                    'Asia/Shanghai',
                    'Asia/Tokyo',
                    'America/New_York',
                    'Europe/London',
                    'UTC',
                  ].map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </label>
            </div>
          )}
          {draft.kind === 'weekly' && (
            <RecurringWeekdays
              days={draft.weekdays}
              disabled={locked}
              onChange={(weekdays) => updateDraft({ weekdays })}
            />
          )}
          {draft.kind !== 'every' && (
            <p className={css.hint}>
              按所选时区执行。夏令时跳过不存在的当地时间，重复时间只执行一次；停机后只处理最近一期。
            </p>
          )}
          {editing && (
            <p className={css.hint}>
              修改影响之后的期次，已排队任务可继续。
              {editing.rule.kind !== 'every' &&
              !editing.rule.time.endsWith(':00')
                ? '原时间含秒，未修改分钟时保留原秒数。'
                : ''}
            </p>
          )}
          {staleEditing && (
            <p className={css.error}>
              任务已变为版本 {latestEditing?.revision ?? '未知'}
              ，请关闭后重新选择编辑。
            </p>
          )}
          {formError && (
            <p className={css.error} role="alert">
              {formError}
            </p>
          )}
          <button
            type="submit"
            className={css.primary}
            disabled={locked || staleEditing || (!editing && !list.enabled)}
          >
            {busy ? '正在提交…' : editing ? '保存修改' : '创建'}
          </button>
        </form>
      )}
      <div className={css.listHeading}>
        <span>当前会话的任务</span>
        <button
          type="button"
          onClick={() => void readList('reset')}
          disabled={list.loading}
        >
          刷新列表
        </button>
      </div>
      {list.error && (
        <p className={css.error} role="alert">
          {list.error}
        </p>
      )}
      {list.enabled === false && (
        <p className={css.hint}>
          当前不能创建新任务，已有任务和执行记录仍可查看。
        </p>
      )}
      {!list.tasks.length && (
        <p className={css.empty}>
          {list.loading ? '正在读取…' : '暂无周期任务'}
        </p>
      )}
      <ul className={css.tasks}>
        {list.tasks.map((task) => (
          <li className={css.task} key={task.id}>
            <div className={css.taskHeading}>
              <strong>{task.name}</strong>
              <span className={css.status} data-status={task.status}>
                {taskLabels[task.status]}
              </span>
            </div>
            <p className={css.prompt} title={task.prompt}>
              {task.prompt}
            </p>
            <p className={css.hint}>
              {ruleLabel(task)} · 版本 {task.revision}
            </p>
            <p className={css.hint}>
              下次执行：
              {task.nextRunAt ? (
                <time dateTime={task.nextRunAt}>
                  {timeLabel(task.nextRunAt, task)}
                </time>
              ) : task.status === 'paused' ? (
                '已暂停'
              ) : (
                '尚未安排'
              )}
            </p>
            {task.latestOccurrence && (
              <p className={css.hint}>
                最近一期：{occurrenceLabels[task.latestOccurrence.status]} ·{' '}
                <time dateTime={task.latestOccurrence.scheduledAt}>
                  {timeLabel(task.latestOccurrence.scheduledAt, task)}
                </time>
              </p>
            )}
            {task.errorMessage && (
              <p className={css.error}>{task.errorMessage}</p>
            )}
            <div className={css.actions}>
              <button
                type="button"
                onClick={() => onOpenSession(task.sessionId)}
              >
                查看会话
              </button>
              <button type="button" onClick={() => openHistory(task)}>
                执行记录
              </button>
              {task.canManage &&
                !['deleted', 'deleting'].includes(task.status) && (
                  <>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => {
                        setEditing(task);
                        setDraft(recurringDraft(task));
                        setFormError('');
                        setFormOpen(true);
                        setConfirmation(null);
                      }}
                    >
                      编辑
                    </button>
                    {task.status === 'enabled' && (
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          setConfirmation({ task, action: 'pause' })
                        }
                      >
                        暂停
                      </button>
                    )}
                    {task.status === 'paused' && (
                      <button
                        type="button"
                        disabled={locked}
                        onClick={() =>
                          setConfirmation({ task, action: 'resume' })
                        }
                      >
                        恢复
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() =>
                        setConfirmation({ task, action: 'delete' })
                      }
                    >
                      删除
                    </button>
                  </>
                )}
            </div>
            {confirmation?.task.id === task.id && (
              <div className={css.confirm}>
                <p>
                  {confirmation.action === 'pause'
                    ? '暂停期间不执行；已排队任务可继续。'
                    : confirmation.action === 'resume'
                      ? '从下一期恢复执行，不补跑暂停期间的期次。'
                      : '删除后不再安排新期次，已排队任务可继续，执行记录保留。'}
                </p>
                <div className={css.actions}>
                  <button type="button" disabled={locked} onClick={confirm}>
                    确认{actionLabels[confirmation.action]}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmation(null)}
                  >
                    返回
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {list.more && (
        <button
          type="button"
          className={css.more}
          disabled={list.loading}
          onClick={() => void readList('more')}
        >
          {list.loading ? '正在读取…' : '加载更多任务'}
        </button>
      )}
      {historyId && (
        <div
          className={css.history}
          role="region"
          aria-label="周期任务执行记录"
        >
          <div className={css.heading}>
            <strong>{history.task?.name ?? '任务'}的执行记录</strong>
            <button
              type="button"
              onClick={() => {
                selected.current = null;
                setHistoryId(null);
                abort('history');
              }}
            >
              关闭记录
            </button>
          </div>
          <button
            type="button"
            disabled={history.loading}
            onClick={() => {
              abort('history');
              historyPager.current = pager();
              void readHistory();
            }}
          >
            刷新记录
          </button>
          {history.error && (
            <p className={css.error} role="alert">
              {history.error}
            </p>
          )}
          {!history.occurrences.length && (
            <p className={css.empty}>
              {history.loading ? '正在读取…' : '暂无执行记录'}
            </p>
          )}
          <ol className={css.occurrences}>
            {history.occurrences.map((item) => (
              <li key={item.id}>
                <div className={css.taskHeading}>
                  <time dateTime={item.scheduledAt}>
                    {timeLabel(item.scheduledAt, history.task ?? undefined)}
                  </time>
                  <span>{occurrenceLabels[item.status]}</span>
                </div>
                <p className={css.hint}>任务版本 {item.revision}</p>
                {item.errorMessage && (
                  <p className={css.error}>{item.errorMessage}</p>
                )}
              </li>
            ))}
          </ol>
          {history.more && (
            <button
              type="button"
              className={css.more}
              disabled={history.loading}
              onClick={() => void readHistory(true)}
            >
              加载更多记录
            </button>
          )}
          {history.task && (
            <button
              type="button"
              onClick={() => onOpenSession(history.task!.sessionId)}
            >
              查看原会话
            </button>
          )}
        </div>
      )}
    </section>
  );
}
