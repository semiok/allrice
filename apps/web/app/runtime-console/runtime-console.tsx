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

  const selected = useMemo(
    () => data?.runtimes.find((item) => item.session.id === selectedId) ?? null,
    [data, selectedId],
  );
  const running = data?.runtimes.filter(
    (item) => item.runtime.state === 'running',
  ).length;
  const bound = data?.runtimes.filter((item) => item.runtime.threadId).length;

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
                <i data-state={item.runtime.state} />
                <span>
                  <strong>{item.session.title}</strong>
                  <small>
                    {item.organization.slug} / {item.workspace.slug}
                  </small>
                </span>
                <em>{item.runtime.state}</em>
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

              <aside className={styles.notice}>
                当前阶段只读取 ChatFlow 的真实运行记录，不启动第二个 DSH
                实例，也不允许从浏览器修改 Runtime。Phase 2 将在这里原样镜像
                Context、Search、Think、Tool 与 Answer 事件。
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
