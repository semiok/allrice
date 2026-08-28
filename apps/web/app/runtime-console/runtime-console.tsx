'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import styles from './runtime-console.module.css';

interface RuntimeInventoryItem {
  organization: { id: string; slug: string; name: string };
  workspace: { id: string; slug: string; name: string };
  owner: { id: string; email: string };
  session: { id: string; title: string; employeeName: string | null };
  runtime: {
    harness: 'dsh';
    state: 'idle' | 'running' | 'interrupted' | 'error';
    threadId: string | null;
    generation: number;
    activeRunId: string | null;
    activeTurnId: string | null;
    workerId: string | null;
    configFingerprint: string;
    lastErrorCode: string | null;
    contextPressureTokens: number;
    compactThresholdTokens: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    updatedAt: string;
  };
  provider: {
    provider: string;
    route: string;
    model: string;
    reasoningEffort: string;
  } | null;
  process: {
    id: string;
    status: 'live' | 'offline';
    workerId: string | null;
    providerRoute: string | null;
    model: string | null;
    reasoningEffort: string | null;
    nativeTools: string[];
    startedAt: string | null;
    lastActivityAt: string | null;
    lastSeenAt: string | null;
  } | null;
}

interface RuntimeConsoleResponse {
  console: {
    name: string;
    authority: string;
    harness: string;
    mode: string;
    source: string;
  };
  runtimes: RuntimeInventoryItem[];
}

interface RuntimeTimelineEvent {
  id: string;
  key: string;
  runId: string;
  sequence: number;
  kind:
    | 'context'
    | 'think'
    | 'search'
    | 'tool'
    | 'todo'
    | 'compaction'
    | 'lifecycle'
    | 'answer';
  status: string;
  title: string;
  detail: string | null;
  occurredAt: string | null;
}

interface RuntimeTimelineResponse {
  timeline: {
    sessionId: string;
    run: { id: string; status: string } | null;
    events: RuntimeTimelineEvent[];
  };
}

function time(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function percentage(value: number, maximum: number) {
  if (maximum <= 0) return 0;
  return Math.min(100, Math.round((value / maximum) * 100));
}

export function RuntimeConsole() {
  const [data, setData] = useState<RuntimeConsoleResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [timeline, setTimeline] = useState<
    RuntimeTimelineResponse['timeline'] | null
  >(null);
  const [timelineError, setTimelineError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/v1/admin/runtime-console', {
      cache: 'no-store',
    });
    if (response.status === 401) {
      window.location.assign('/login?next=/runtime-console');
      return;
    }
    const body = (await response.json().catch(() => null)) as
      RuntimeConsoleResponse | { error?: { message?: string } } | null;
    if (!response.ok) {
      throw new Error(
        (body as { error?: { message?: string } } | null)?.error?.message ??
          `Runtime Console 加载失败（${response.status}）`,
      );
    }
    const next = body as RuntimeConsoleResponse;
    setData(next);
    setSelectedId((current) =>
      current && next.runtimes.some((item) => item.session.id === current)
        ? current
        : (next.runtimes[0]?.session.id ?? null),
    );
    setUpdatedAt(new Date());
    setError('');
  }, []);

  useEffect(() => {
    void load().catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : '加载失败'),
    );
    const timer = window.setInterval(
      () => void load().catch(() => undefined),
      5_000,
    );
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setTimeline(null);
      return;
    }
    let active = true;
    const loadTimeline = async () => {
      const response = await fetch(
        `/api/v1/admin/runtime-console/${selectedId}/events`,
        { cache: 'no-store' },
      );
      const body = (await response.json().catch(() => null)) as
        RuntimeTimelineResponse | { error?: { message?: string } } | null;
      if (!response.ok) {
        throw new Error(
          (body as { error?: { message?: string } } | null)?.error?.message ??
            `事件加载失败（${response.status}）`,
        );
      }
      if (!active) return;
      setTimeline((body as RuntimeTimelineResponse).timeline);
      setTimelineError('');
    };
    void loadTimeline().catch((reason: unknown) =>
      setTimelineError(
        reason instanceof Error ? reason.message : '事件加载失败',
      ),
    );
    const timer = window.setInterval(
      () => void loadTimeline().catch(() => undefined),
      1_500,
    );
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const selected = useMemo(
    () => data?.runtimes.find((item) => item.session.id === selectedId) ?? null,
    [data, selectedId],
  );
  const running = data?.runtimes.filter(
    (item) => item.process?.status === 'live',
  ).length;
  const bound = data?.runtimes.filter((item) => item.runtime.threadId).length;
  const projectedTimeline = useMemo(() => {
    const items = new Map<string, RuntimeTimelineEvent>();
    for (const event of timeline?.events ?? []) {
      const previous = items.get(event.key);
      items.set(event.key, {
        ...event,
        sequence: previous?.sequence ?? event.sequence,
        title:
          previous && event.title === '工具调用完成'
            ? previous.title
            : event.title,
        detail: event.detail ?? previous?.detail ?? null,
      });
    }
    return [...items.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }, [timeline]);

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span>AR</span>
          <div>
            <strong>AllRice Runtime Console</strong>
            <small>真实 Worker Runtime · DSH Native</small>
          </div>
        </div>
        <div className={styles.actions}>
          <span className={styles.readonly}>只读</span>
          <button onClick={() => void load()}>刷新</button>
          <a href="https://dsh.bplabs.xyz/">打开 DSH Lab ↗</a>
        </div>
      </header>

      <section className={styles.summary}>
        <div>
          <span>活跃 Runtime</span>
          <strong>{running ?? 0}</strong>
        </div>
        <div>
          <span>已绑定 Session</span>
          <strong>{bound ?? 0}</strong>
        </div>
        <div>
          <span>Harness</span>
          <strong>DSH</strong>
        </div>
        <div>
          <span>控制权</span>
          <strong>ChatFlow 3.0</strong>
        </div>
        <p>
          {updatedAt
            ? `最近刷新 ${time(updatedAt.toISOString())}`
            : '正在连接事实源…'}
        </p>
      </section>

      {error ? <p className={styles.error}>{error}</p> : null}
      <div className={styles.content}>
        <aside className={styles.sidebar}>
          <header>
            <strong>Runtime Inventory</strong>
            <small>{data?.runtimes.length ?? 0}</small>
          </header>
          <div className={styles.runtimeList}>
            {data?.runtimes.map((item) => (
              <button
                className={
                  item.session.id === selectedId ? styles.selected : ''
                }
                key={item.session.id}
                onClick={() => setSelectedId(item.session.id)}
              >
                <i
                  data-state={
                    item.process?.status === 'live'
                      ? 'running'
                      : item.runtime.state
                  }
                />
                <span>
                  <strong>{item.session.title}</strong>
                  <small>
                    {item.organization.slug} / {item.workspace.slug}
                  </small>
                </span>
                <em>
                  {item.process?.status === 'live'
                    ? 'live process'
                    : item.runtime.state}
                </em>
              </button>
            ))}
            {data && data.runtimes.length === 0 ? (
              <p className={styles.empty}>还没有创建过 DSH Session。</p>
            ) : null}
          </div>
        </aside>

        <section className={styles.detail}>
          {selected ? (
            <>
              <header className={styles.detailHeader}>
                <div>
                  <p>{selected.session.employeeName ?? 'AI 员工'}</p>
                  <h1>{selected.session.title}</h1>
                  <span>{selected.owner.email}</span>
                </div>
                <span
                  className={styles.state}
                  data-state={selected.runtime.state}
                >
                  {selected.runtime.state}
                </span>
              </header>

              <div className={styles.grid}>
                <article>
                  <p>Runtime 身份</p>
                  <dl>
                    <div>
                      <dt>Session</dt>
                      <dd>{selected.session.id}</dd>
                    </div>
                    <div>
                      <dt>Thread</dt>
                      <dd>{selected.runtime.threadId ?? '尚未绑定'}</dd>
                    </div>
                    <div>
                      <dt>Generation</dt>
                      <dd>{selected.runtime.generation}</dd>
                    </div>
                    <div>
                      <dt>Worker</dt>
                      <dd>{selected.runtime.workerId ?? '当前无活跃租约'}</dd>
                    </div>
                  </dl>
                </article>
                <article>
                  <p>冻结配置</p>
                  <dl>
                    <div>
                      <dt>Provider</dt>
                      <dd>{selected.provider?.route ?? 'unknown'}</dd>
                    </div>
                    <div>
                      <dt>Model</dt>
                      <dd>{selected.provider?.model ?? 'unknown'}</dd>
                    </div>
                    <div>
                      <dt>Reasoning</dt>
                      <dd>{selected.provider?.reasoningEffort ?? 'unknown'}</dd>
                    </div>
                    <div>
                      <dt>Fingerprint</dt>
                      <dd>{selected.runtime.configFingerprint}…</dd>
                    </div>
                  </dl>
                </article>
                <article>
                  <p>Worker 子进程</p>
                  <dl>
                    <div>
                      <dt>Process</dt>
                      <dd>{selected.process?.id ?? '没有活跃进程记录'}</dd>
                    </div>
                    <div>
                      <dt>状态</dt>
                      <dd>{selected.process?.status ?? 'not-started'}</dd>
                    </div>
                    <div>
                      <dt>最近心跳</dt>
                      <dd>{time(selected.process?.lastSeenAt ?? null)}</dd>
                    </div>
                    <div>
                      <dt>Native Tools</dt>
                      <dd>{selected.process?.nativeTools.join(', ') || '—'}</dd>
                    </div>
                  </dl>
                </article>
              </div>

              <article className={styles.lifecycle}>
                <header>
                  <strong>Context 与生命周期</strong>
                  <span>持久事实源</span>
                </header>
                <div className={styles.meter}>
                  <span
                    style={{
                      width: `${percentage(
                        selected.runtime.contextPressureTokens,
                        selected.runtime.compactThresholdTokens,
                      )}%`,
                    }}
                  />
                </div>
                <dl>
                  <div>
                    <dt>上下文压力</dt>
                    <dd>
                      {percentage(
                        selected.runtime.contextPressureTokens,
                        selected.runtime.compactThresholdTokens,
                      )}
                      %
                    </dd>
                  </div>
                  <div>
                    <dt>最近启动</dt>
                    <dd>{time(selected.runtime.lastStartedAt)}</dd>
                  </div>
                  <div>
                    <dt>最近完成</dt>
                    <dd>{time(selected.runtime.lastCompletedAt)}</dd>
                  </div>
                  <div>
                    <dt>最近错误</dt>
                    <dd>{selected.runtime.lastErrorCode ?? '无'}</dd>
                  </div>
                </dl>
              </article>

              <article className={styles.timeline}>
                <header>
                  <div>
                    <strong>DSH Native Event Stream</strong>
                    <span>按 Harness 原始顺序 · 1.5 秒刷新</span>
                  </div>
                  <em data-state={timeline?.run?.status ?? 'idle'}>
                    {timeline?.run?.status ?? 'no run'}
                  </em>
                </header>
                {timelineError ? (
                  <p className={styles.timelineError}>{timelineError}</p>
                ) : projectedTimeline.length ? (
                  <ol className={styles.eventList}>
                    {projectedTimeline.map((event) => (
                      <li key={event.key} data-kind={event.kind}>
                        <i>{event.kind.slice(0, 1).toUpperCase()}</i>
                        <div>
                          <span>
                            <strong>{event.title}</strong>
                            <em>{event.status}</em>
                          </span>
                          {event.detail ? <p>{event.detail}</p> : null}
                        </div>
                        <time>{time(event.occurredAt)}</time>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={styles.timelineEmpty}>
                    这个 Session 还没有 DSH 原生事件。
                  </p>
                )}
              </article>

              <aside className={styles.notice}>
                事件来自真实 Worker Runtime。ChatFlow 仅负责租户边界、持久化和
                脱敏；这里不会展示原始提示词、工具参数、密钥、宿主机路径或隐藏推理。
              </aside>
            </>
          ) : (
            <div className={styles.blank}>
              选择一个 Runtime 查看真实运行状态。
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
