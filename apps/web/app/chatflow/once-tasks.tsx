'use client';

/**
 * Schedule header/portal structure adapted from DeepSeek Harness ui-schedule,
 * commit 687f282e8625c6b8d11ff58211a90524be2e4317 (0.2.1-rc.2).
 * Uses the official clock, positioning and outside-pointer primitives.
 * Copyright (c) 2026 DeepSeek. MIT License:
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  IconClockOutlineRegular,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  CreateOnceTaskInputSchema,
  OnceTaskListSchema,
  OnceTaskSchema,
  type CreateOnceTaskInput,
  type OnceTask,
} from '@allrice/contracts';
import css from './once-tasks.module.css';
import { RecurringTasksPanel } from './recurring-tasks';

type Props = {
  sessionId: string | null;
  /** UI cache identity only. The server derives the employee and owner. */
  scope: string;
  headers: Record<string, string>;
  onOpenSession: (sessionId: string) => void;
};

const statusLabels: Record<OnceTask['status'], string> = {
  preparing: '准备中',
  pending: '待执行',
  queued: '排队中',
  running: '执行中',
  awaiting_input: '待你回复',
  succeeded: '已完成',
  failed: '执行失败',
  canceled: '已取消',
  not_executed: '未执行',
};

function localDateTime(date: Date): string {
  const part = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function taskTime(task: OnceTask): string {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: task.timezone,
      timeZoneName: 'short',
    }).format(new Date(task.runAt));
  } catch {
    return new Date(task.runAt).toLocaleString('zh-CN', { hour12: false });
  }
}

type PendingRequest =
  | { version: 1; kind: 'create'; body: CreateOnceTaskInput }
  | { version: 1; kind: 'cancel'; taskId: string; clientRequestId: string };

function storedRequest(raw: string): PendingRequest {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid saved request');
  const entry = value as Record<string, unknown>;
  const keys =
    entry.kind === 'create'
      ? ['version', 'kind', 'body']
      : ['version', 'kind', 'taskId', 'clientRequestId'];
  if (
    entry.version !== 1 ||
    Object.keys(entry).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(entry, key))
  )
    throw new Error('invalid saved request');
  if (entry.kind === 'create')
    return {
      version: 1,
      kind: 'create',
      body: CreateOnceTaskInputSchema.parse(entry.body),
    };
  if (entry.kind !== 'cancel') throw new Error('invalid saved request');
  return {
    version: 1,
    kind: 'cancel',
    taskId: OnceTaskSchema.shape.id.parse(entry.taskId),
    clientRequestId: OnceTaskSchema.shape.clientRequestId.parse(
      entry.clientRequestId,
    ),
  };
}

function matchesRequest(
  pending: PendingRequest,
  task: OnceTask,
  sessionId: string,
): boolean {
  if (pending.kind === 'cancel')
    return (
      task.id === pending.taskId &&
      task.clientRequestId === pending.clientRequestId
    );
  const body = pending.body;
  return (
    task.clientRequestId === body.clientRequestId &&
    task.sessionId === sessionId &&
    task.name === body.name &&
    task.prompt === body.prompt &&
    task.runAt === body.runAt &&
    task.timezone === body.timezone &&
    (task.conversationMode ?? 'reuse') === (body.conversationMode ?? 'reuse')
  );
}

function mergeTasks(fresh: OnceTask[], previous: OnceTask[]): OnceTask[] {
  const byId = new Map(previous.map((task) => [task.id, task]));
  for (const task of fresh) byId.set(task.id, task);
  return [...byId.values()];
}

function cancelResultSettled(task: OnceTask): boolean {
  // Losing write permission also makes canCancel false. Only an execution or
  // terminal state proves that the original cancel no longer needs a decision.
  return (
    !task.canCancel &&
    (task.runId !== null || !['preparing', 'pending'].includes(task.status))
  );
}

export function OnceTasks(props: Props) {
  const headerKey = JSON.stringify(
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(headerKey)) as Record<string, string>,
    [headerKey],
  );
  // Chatflow supplies organization/workspace/viewer/AI, all stable identifiers.
  // Headers may contain credentials and never enter persisted keys or values.
  const identity = props.scope.split('/');
  const storageKey =
    props.sessionId &&
    identity.length === 4 &&
    identity.every(
      (part) => part.length > 0 && part !== 'undefined' && part !== 'null',
    )
      ? 'allrice:once-pending:v1:' +
        JSON.stringify([...identity, props.sessionId])
      : null;
  const scopeKey = JSON.stringify([props.scope, props.sessionId, headerKey]);
  return (
    <OnceTasksMenu
      key={scopeKey}
      {...props}
      headers={headers}
      storageKey={storageKey}
    />
  );
}

function OnceTasksMenu({
  sessionId,
  scope,
  headers,
  onOpenSession,
  storageKey,
}: Props & { storageKey: string | null }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<'once' | 'recurring'>('once');
  const openRef = useRef(open);
  openRef.current = open;
  const [visible, setVisible] = useState(true);
  const [snapshot, setSnapshot] = useState<{
    tasks: OnceTask[];
    enabled: boolean | null;
    nextCursor: string | null;
    loading: boolean;
    error: string;
  }>({
    tasks: [],
    enabled: null,
    nextCursor: null,
    loading: false,
    error: '',
  });
  const [formOpen, setFormOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [conversationMode, setConversationMode] = useState<
    'reuse' | 'new_each_run'
  >('reuse');
  const [time, setTime] = useState(() =>
    localDateTime(new Date(Date.now() + 60 * 60_000)),
  );
  const [timezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState({ text: '', error: false });
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const writing = useRef(false);
  const epoch = useRef(0);
  const readSequence = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const exactController = useRef<AbortController | null>(null);
  const nextCursor = useRef<string | null>(null);
  const paginated = useRef(false);
  const writes = useRef(new Set<AbortController>());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const url = sessionId
    ? '/api/v1/sessions/' + encodeURIComponent(sessionId) + '/once-tasks'
    : null;
  const position = useAnchoredPosition({
    open,
    anchorRef: trigger,
    panelRef: panel,
    side: 'bottom',
    gap: 5,
    margin: 16,
  });
  useDismissOnOutsidePointer(root, open, setOpen, panel);

  const invalidateRead = useCallback(() => {
    readSequence.current++;
    readController.current?.abort();
    readController.current = null;
  }, []);

  useEffect(() => {
    epoch.current++;
    const controllers = writes.current;
    try {
      if (!storageKey) throw new Error('identity unavailable');
      const saved = sessionStorage.getItem(storageKey);
      const restored = saved === null ? null : storedRequest(saved);
      pendingRef.current = restored;
      setPending(restored);
      setStorageReady(true);
      if (restored) {
        setNotice({
          text:
            restored.kind === 'create'
              ? '上次创建结果尚未确认，打开后将按原请求读取结果。'
              : '上次取消结果尚未确认，打开后将读取任务状态。',
          error: true,
        });
        if (restored.kind === 'create') {
          setPrompt(restored.body.prompt);
          setTime(localDateTime(new Date(restored.body.runAt)));
          setFormOpen(true);
        }
      }
    } catch {
      setStorageReady(false);
      setStorageError(
        storageKey
          ? '无法读取待确认请求，暂时不能提交任务；已有任务仍可查看。'
          : '当前会话身份尚未就绪，暂时不能提交任务。',
      );
    }
    return () => {
      epoch.current++;
      invalidateRead();
      exactController.current?.abort();
      exactController.current = null;
      for (const controller of controllers) controller.abort();
      // A transport abort proves nothing about COMMIT. Keep the saved request.
    };
  }, [storageKey, invalidateRead]);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const saveRequest = useCallback(
    (request: PendingRequest) => {
      try {
        if (!storageKey) throw new Error('identity unavailable');
        if (sessionStorage.getItem(storageKey) !== null)
          throw new Error('unresolved saved request');
        sessionStorage.setItem(storageKey, JSON.stringify(request));
        pendingRef.current = request;
        setPending(request);
        return true;
      } catch {
        setStorageReady(false);
        setStorageError('无法保存本次请求，尚未提交，请恢复会话存储后重试。');
        return false;
      }
    },
    [storageKey],
  );

  const clearRequest = useCallback(
    (request: PendingRequest) => {
      if (pendingRef.current !== request) return false;
      try {
        if (!storageKey) throw new Error('identity unavailable');
        const saved = sessionStorage.getItem(storageKey);
        if (
          saved !== null &&
          JSON.stringify(storedRequest(saved)) !== JSON.stringify(request)
        )
          throw new Error('saved request changed');
        sessionStorage.removeItem(storageKey);
        pendingRef.current = null;
        setPending(null);
        setStorageReady(true);
        setStorageError('');
        return true;
      } catch {
        setStorageReady(false);
        setStorageError('结果已读取，但请求状态尚未保存，请重新确认结果。');
        return false;
      }
    },
    [storageKey],
  );

  const acceptTask = useCallback(
    (request: PendingRequest, task: OnceTask, exact: boolean) => {
      if (
        !sessionId ||
        !matchesRequest(request, task, sessionId) ||
        (request.kind === 'cancel' && !cancelResultSettled(task)) ||
        !clearRequest(request)
      )
        return false;
      invalidateRead();
      setSnapshot((previous) => ({
        ...previous,
        loading: false,
        tasks: mergeTasks([task], previous.tasks),
      }));
      if (request.kind === 'create') {
        setPrompt('');
        setFormOpen(false);
        setTime(localDateTime(new Date(Date.now() + 60 * 60_000)));
      }
      setNotice({
        text:
          request.kind === 'create'
            ? exact
              ? '已确认定时任务已创建。'
              : '定时任务已创建。'
            : task.status === 'canceled'
              ? '任务已取消。'
              : '任务已进入新的状态，请查看列表。',
        error: false,
      });
      return true;
    },
    [sessionId, clearRequest, invalidateRead],
  );

  const read = useCallback(
    async (mode: 'refresh' | 'more' = 'refresh', reset = false) => {
      if (
        !url ||
        document.visibilityState !== 'visible' ||
        readController.current
      )
        return;
      const cursor = mode === 'more' ? nextCursor.current : null;
      if (mode === 'more' && cursor === null) return;
      const scopeEpoch = epoch.current;
      const sequence = ++readSequence.current;
      const controller = new AbortController();
      readController.current = controller;
      const current = () =>
        epoch.current === scopeEpoch &&
        readSequence.current === sequence &&
        readController.current === controller &&
        !controller.signal.aborted;
      setSnapshot((previous) => ({ ...previous, loading: true, error: '' }));
      try {
        const response = await fetch(
          cursor === null ? url : url + '?cursor=' + encodeURIComponent(cursor),
          {
            headers,
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!current()) return;
        if ([401, 403, 404].includes(response.status)) {
          setSnapshot({
            tasks: [],
            enabled: false,
            nextCursor: null,
            loading: false,
            error: '暂时无法查看定时任务，请确认当前会话仍可使用。',
          });
          nextCursor.current = null;
          paginated.current = false;
          return;
        }
        if (!response.ok) throw new Error('list');
        const result = OnceTaskListSchema.safeParse(await response.json());
        if (
          !result.success ||
          (cursor !== null && result.data.nextCursor === cursor)
        )
          throw new Error('list');
        if (!current()) return;
        if (mode === 'more') paginated.current = true;
        else if (reset) paginated.current = false;
        if (mode === 'more' || !paginated.current)
          nextCursor.current = result.data.nextCursor;
        setSnapshot((previous) => ({
          tasks: mergeTasks(result.data.tasks, previous.tasks),
          enabled: result.data.enabled,
          nextCursor: nextCursor.current,
          loading: false,
          error: '',
        }));
      } catch {
        if (current())
          setSnapshot((previous) => ({
            ...previous,
            loading: false,
            error: '任务列表暂时无法加载，请重试。',
          }));
      } finally {
        if (readController.current === controller)
          readController.current = null;
      }
    },
    [url, headers],
  );

  const reconcile = useCallback(async () => {
    const request = pendingRef.current;
    if (
      !url ||
      !sessionId ||
      !request ||
      writing.current ||
      exactController.current ||
      document.visibilityState !== 'visible'
    )
      return;
    const requestId =
      request.kind === 'create'
        ? request.body.clientRequestId
        : request.clientRequestId;
    const scopeEpoch = epoch.current;
    const controller = new AbortController();
    exactController.current = controller;
    const current = () =>
      epoch.current === scopeEpoch &&
      exactController.current === controller &&
      pendingRef.current === request &&
      !controller.signal.aborted;
    setChecking(true);
    try {
      const response = await fetch(
        url + '?clientRequestId=' + encodeURIComponent(requestId),
        {
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (!current()) return;
      // Denial, conflict and absence after an unknown write never prove rollback.
      if (!response.ok) throw new Error('unknown result');
      const result = OnceTaskListSchema.safeParse(await response.json());
      if (
        !result.success ||
        result.data.nextCursor !== null ||
        result.data.tasks.length > 1
      )
        throw new Error('unknown result');
      if (!current()) return;
      const task = result.data.tasks[0];
      if (!task) throw new Error('not yet confirmed');
      if (!matchesRequest(request, task, sessionId))
        throw new Error('wrong request result');
      if (request.kind === 'cancel' && !cancelResultSettled(task)) {
        setSnapshot((previous) => ({
          ...previous,
          tasks: mergeTasks([task], previous.tasks),
        }));
        throw new Error('cancel not yet confirmed');
      }
      acceptTask(request, task, true);
    } catch {
      if (current())
        setNotice({
          text:
            request.kind === 'create'
              ? '创建结果尚未确认，请继续读取原请求结果；不会重复提交。'
              : '取消结果尚未确认，请继续读取任务状态；不会重复取消。',
          error: true,
        });
    } finally {
      if (exactController.current === controller) {
        exactController.current = null;
        setChecking(false);
      }
    }
  }, [url, sessionId, headers, acceptTask]);

  useEffect(() => {
    if (!open || !visible || !url || section !== 'once') return;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void read();
      void reconcile();
    };
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      clearInterval(timer);
      invalidateRead();
      exactController.current?.abort();
      exactController.current = null;
      setChecking(false);
      setSnapshot((previous) => ({ ...previous, loading: false }));
    };
  }, [open, section, visible, url, read, reconcile, invalidateRead]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  const submit = async (request: PendingRequest) => {
    if (
      !url ||
      writing.current ||
      pendingRef.current ||
      !storageReady ||
      !saveRequest(request)
    )
      return;
    writing.current = true;
    setBusy(true);
    setNotice({ text: '', error: false });
    const scopeEpoch = epoch.current;
    const current = () =>
      epoch.current === scopeEpoch && pendingRef.current === request;
    const controller = new AbortController();
    writes.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(
        request.kind === 'cancel'
          ? url + '/' + encodeURIComponent(request.taskId) + '/cancel'
          : url,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers:
            request.kind === 'create'
              ? { ...headers, 'content-type': 'application/json' }
              : headers,
          ...(request.kind === 'create'
            ? { body: JSON.stringify(request.body) }
            : {}),
          signal: controller.signal,
        },
      );
      if (!current()) return;
      if (response.status === 409 || response.status === 503) {
        const problem: unknown = await response.json().catch(() => null);
        const code =
          problem && typeof problem === 'object' && 'error' in problem
            ? problem.error
            : null;
        if (!current()) return;
        if (code === 'time_invalid' || code === 'disabled') {
          // An explicit initial validation/readiness rejection precedes writes.
          // Unknown operations never POST again and cannot reach this branch.
          clearRequest(request);
          if (code === 'disabled')
            setSnapshot((previous) => ({ ...previous, enabled: false }));
          setNotice({
            text:
              code === 'time_invalid'
                ? '请选择未来一年内的执行时间。'
                : '当前会话暂不支持定时任务。',
            error: true,
          });
          return;
        }
      }
      if ([400, 401, 403, 404, 413, 422].includes(response.status)) {
        // This is the first and only submission. Restored/unknown operations
        // only use GET and never enter this known initial rejection branch.
        clearRequest(request);
        if ([401, 403, 404].includes(response.status))
          setSnapshot({
            tasks: [],
            enabled: false,
            nextCursor: null,
            loading: false,
            error: '',
          });
        setNotice({
          text:
            request.kind === 'create'
              ? '未能创建任务，请检查内容、执行时间及当前会话。'
              : '未能取消任务，请重新读取任务状态。',
          error: true,
        });
        return;
      }
      if (!response.ok) throw new Error('unknown write');
      const payload: unknown = await response.json();
      const result = OnceTaskSchema.safeParse(
        payload && typeof payload === 'object' && 'task' in payload
          ? payload.task
          : undefined,
      );
      if (!current()) return;
      if (
        !result.success ||
        !sessionId ||
        !matchesRequest(request, result.data, sessionId) ||
        (request.kind === 'cancel' && !cancelResultSettled(result.data))
      )
        throw new Error('unknown write binding');
      acceptTask(request, result.data, false);
    } catch {
      if (!current()) return;
      setNotice({
        text:
          request.kind === 'create'
            ? '创建结果尚未确认，请读取原请求结果；不会重复提交。'
            : '取消结果尚未确认，请读取任务状态；不会重复取消。',
        error: true,
      });
    } finally {
      clearTimeout(timeout);
      writes.current.delete(controller);
      if (epoch.current === scopeEpoch) {
        writing.current = false;
        setBusy(false);
        setConfirmCancel(null);
        if (openRef.current && document.visibilityState === 'visible') {
          void read();
          void reconcile();
        }
      }
    }
  };

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (writing.current || pendingRef.current || snapshot.enabled !== true)
      return;
    const date = new Date(time);
    if (
      !prompt.trim() ||
      !Number.isFinite(date.getTime()) ||
      date.getTime() <= Date.now() ||
      localDateTime(date) !== time
    ) {
      setNotice({
        text: '请填写任务内容，并选择未来的执行时间。',
        error: true,
      });
      return;
    }
    const result = CreateOnceTaskInputSchema.safeParse({
      clientRequestId: crypto.randomUUID(),
      name: prompt.trim().split('\n')[0]!.slice(0, 60),
      prompt: prompt.trim(),
      runAt: date.toISOString(),
      timezone,
      conversationMode,
    });
    if (!result.success) {
      setNotice({ text: '请检查任务内容和执行时间后重试。', error: true });
      return;
    }
    void submit({ version: 1, kind: 'create', body: result.data });
  };

  const tasks = [...snapshot.tasks].sort((a, b) => {
    const active = (task: OnceTask) =>
      ['preparing', 'pending', 'queued', 'running', 'awaiting_input'].includes(
        task.status,
      );
    return (
      Number(active(b)) - Number(active(a)) ||
      (active(a)
        ? Date.parse(a.runAt) - Date.parse(b.runAt)
        : Date.parse(b.createdAt) - Date.parse(a.createdAt))
    );
  });

  return (
    <div ref={root} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={css.trigger}
        aria-label="定时任务"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={!sessionId}
        title={sessionId ? '定时任务' : '先开始当前对话，即可设置定时任务'}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) requestAnimationFrame(() => panel.current?.focus());
        }}
      >
        <IconClockOutlineRegular size={18} />
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panel}
            className={css.panel}
            role="dialog"
            aria-label="定时任务"
            tabIndex={-1}
            style={position ?? { visibility: 'hidden', left: 0, top: 0 }}
            onKeyDown={onKeyDown}
          >
            <div className={css.heading}>
              <div>
                <h2>定时任务</h2>
                <p>
                  {section === 'once'
                    ? '当前 AI 的一次性任务'
                    : '当前 AI 的周期任务'}
                </p>
              </div>
              {section === 'once' && (
                <button
                  type="button"
                  disabled={
                    snapshot.enabled !== true ||
                    !storageReady ||
                    pending !== null ||
                    busy
                  }
                  onClick={() => setFormOpen((value) => !value)}
                >
                  {formOpen ? '收起' : '新建任务'}
                </button>
              )}
              <button type="button" aria-label="关闭定时任务" onClick={close}>
                ×
              </button>
            </div>
            <div
              className={css.sections}
              role="group"
              aria-label="定时任务类型"
            >
              <button
                type="button"
                aria-pressed={section === 'once'}
                onClick={() => setSection('once')}
              >
                一次性
              </button>
              <button
                type="button"
                aria-pressed={section === 'recurring'}
                onClick={() => setSection('recurring')}
              >
                周期
              </button>
            </div>
            <div className={css.content}>
              {section === 'recurring' && sessionId ? (
                <RecurringTasksPanel
                  sessionId={sessionId}
                  scope={scope}
                  headers={headers}
                  onOpenSession={(id) => {
                    setOpen(false);
                    onOpenSession(id);
                  }}
                />
              ) : (
                <>
                  {notice.text && (
                    <p
                      className={notice.error ? css.error : css.notice}
                      role={notice.error ? 'alert' : 'status'}
                    >
                      {notice.text}
                    </p>
                  )}
                  {snapshot.error && (
                    <p className={css.error} role="alert">
                      {snapshot.error}
                    </p>
                  )}
                  {storageError && (
                    <p className={css.error} role="alert">
                      {storageError}
                    </p>
                  )}
                  {pending && (
                    <div className={css.reconcile}>
                      <p className={css.hint}>
                        {pending.kind === 'create'
                          ? '保留原创建请求，等待确认结果。'
                          : '保留取消请求，等待确认任务状态。'}
                      </p>
                      <button
                        type="button"
                        disabled={busy || checking}
                        onClick={() => void reconcile()}
                      >
                        {checking
                          ? '正在确认…'
                          : pending.kind === 'create'
                            ? '确认创建结果'
                            : '确认取消结果'}
                      </button>
                    </div>
                  )}
                  {snapshot.enabled === false && !snapshot.error && (
                    <p className={css.empty}>当前会话暂不支持定时任务。</p>
                  )}
                  {formOpen && snapshot.enabled === true && (
                    <form className={css.form} onSubmit={create}>
                      <div className={css.field}>
                        <label htmlFor={`${id}-prompt`}>任务内容</label>
                        <textarea
                          id={`${id}-prompt`}
                          value={prompt}
                          onChange={(event) => setPrompt(event.target.value)}
                          placeholder="到时请帮我…"
                          rows={3}
                          disabled={busy || pending !== null}
                          required
                        />
                      </div>
                      <div className={css.field}>
                        <label htmlFor={`${id}-time`}>执行时间</label>
                        <input
                          id={`${id}-time`}
                          type="datetime-local"
                          value={time}
                          onChange={(event) => setTime(event.target.value)}
                          disabled={busy || pending !== null}
                          required
                        />
                      </div>
                      <p className={css.hint}>
                        按当前时区 {timezone} 执行一次。
                      </p>
                      <div className={css.field}>
                        <label htmlFor={`${id}-conversation`}>执行会话</label>
                        <select
                          id={`${id}-conversation`}
                          value={conversationMode}
                          disabled={busy || pending !== null}
                          onChange={(event) =>
                            setConversationMode(
                              event.target.value === 'new_each_run'
                                ? 'new_each_run'
                                : 'reuse',
                            )
                          }
                        >
                          <option value="reuse">沿用来源聊天</option>
                          <option value="new_each_run">每次新建聊天</option>
                        </select>
                      </div>
                      <button
                        type="submit"
                        className={css.primary}
                        disabled={busy || pending !== null || !storageReady}
                      >
                        {busy
                          ? '提交中…'
                          : pending !== null
                            ? '等待确认'
                            : '创建任务'}
                      </button>
                    </form>
                  )}
                  <div className={css.listHeading}>
                    <span>
                      {snapshot.loading
                        ? '正在读取…'
                        : `已加载 ${tasks.length} 项任务`}
                    </span>
                    <button
                      type="button"
                      onClick={() => void read('refresh', true)}
                      disabled={snapshot.loading}
                    >
                      重新读取
                    </button>
                  </div>
                  <ul
                    className={css.list}
                    aria-label="当前 AI 的定时任务"
                    aria-busy={snapshot.loading}
                  >
                    {tasks.map((task) => (
                      <li key={task.id} className={css.task}>
                        <div className={css.taskHeading}>
                          <p className={css.summary} title={task.prompt}>
                            {task.name}
                          </p>
                          <span
                            className={css.status}
                            data-status={task.status}
                          >
                            {statusLabels[task.status]}
                          </span>
                        </div>
                        <time
                          className={css.time}
                          dateTime={task.runAt}
                          title={task.timezone}
                        >
                          {taskTime(task)}
                        </time>
                        {task.errorMessage &&
                          (task.status === 'failed' ||
                            task.status === 'not_executed') && (
                            <p className={css.error}>{task.errorMessage}</p>
                          )}
                        <div className={css.actions}>
                          <span>
                            执行会话：
                            {task.conversationMode === 'new_each_run'
                              ? '每次新建聊天'
                              : '沿用来源聊天'}
                          </span>
                          {task.runId && (
                            <button
                              type="button"
                              onClick={() => {
                                setOpen(false);
                                onOpenSession(
                                  task.resultSessionId ?? task.sessionId,
                                );
                              }}
                            >
                              查看本轮结果
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setOpen(false);
                              onOpenSession(task.sessionId);
                            }}
                          >
                            查看原会话
                          </button>
                          {task.canCancel &&
                            (confirmCancel === task.id ? (
                              <>
                                <span>取消这项任务？</span>
                                <button
                                  type="button"
                                  disabled={
                                    busy ||
                                    pending !== null ||
                                    !storageReady ||
                                    snapshot.enabled !== true
                                  }
                                  onClick={() =>
                                    void submit({
                                      version: 1,
                                      kind: 'cancel',
                                      taskId: task.id,
                                      clientRequestId: task.clientRequestId,
                                    })
                                  }
                                >
                                  确认取消
                                </button>
                                <button
                                  type="button"
                                  disabled={busy || pending !== null}
                                  onClick={() => setConfirmCancel(null)}
                                >
                                  保留
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={
                                  busy ||
                                  pending !== null ||
                                  !storageReady ||
                                  snapshot.enabled !== true
                                }
                                onClick={() => setConfirmCancel(task.id)}
                              >
                                取消任务
                              </button>
                            ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {snapshot.nextCursor !== null && (
                    <button
                      type="button"
                      className={css.more}
                      disabled={snapshot.loading}
                      onClick={() => void read('more')}
                    >
                      {snapshot.loading ? '正在读取…' : '加载更多'}
                    </button>
                  )}
                  {!snapshot.loading &&
                    !snapshot.error &&
                    snapshot.enabled === true &&
                    tasks.length === 0 && (
                      <p className={css.empty}>
                        暂无定时任务，也可以在聊天中让 AI 创建。
                      </p>
                    )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
