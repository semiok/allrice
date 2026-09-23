'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { GovernanceConsole } from './governance-console';
import { TenantAdministration } from './tenant-administration';
import { RunUsageSummary } from './run-usage';
import { RunTimingSummary } from './run-timing';
import {
  runtimeCapabilityCatalog,
  type RuntimeCapabilityCatalogGroup,
} from './runtime-capability-catalog';
import { EmployeeProduction } from './employee-production';
import {
  runtimeCapabilityFacts,
  type RuntimeCapabilityResponse,
} from './runtime-capability-facts';
import {
  DshReleaseSummary,
  DshUpgradeCapabilities,
} from './dsh-upgrade-capabilities';
import {
  aggregateRuntimeTimelineEvents,
  type RuntimeTimelineEvent,
  type RuntimeTimelineItem,
  type RuntimeTimelineTurn,
} from './runtime-timeline';
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

interface TenantRuntimeItem {
  organization: { id: string; slug: string; name: string };
  workspace: { id: string; slug: string; name: string };
  sessions: {
    total: number;
    runtimeBound: number;
    active: number;
    error: number;
    lastRuntimeAt: string | null;
  };
  bridge: {
    deviceId: string;
    name: string;
    platform: string;
    protocolVersion: number | null;
    capabilities: string[];
    status: 'online' | 'offline';
    lastSeenAt: string | null;
    workspaceLabel: string | null;
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
  tenants: TenantRuntimeItem[];
  runtimes: RuntimeInventoryItem[];
}

interface RuntimeTimelineResponse {
  timeline: {
    sessionId: string;
    run: { id: string; status: string } | null;
    turns: RuntimeTimelineTurn[];
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

function runtimeStateLabel(item: RuntimeInventoryItem) {
  if (item.process?.status === 'live') return 'LIVE';
  if (item.runtime.state === 'running') return '运行中';
  if (item.runtime.state === 'error') return '历史失败';
  if (item.runtime.state === 'interrupted') return '已中断';
  return '已结束';
}

type TenantBridgeState =
  'ready' | 'workspace-missing' | 'offline' | 'not-configured';

function tenantBridgeState(tenant: TenantRuntimeItem): TenantBridgeState {
  if (!tenant.bridge) return 'not-configured';
  if (tenant.bridge.status === 'offline') return 'offline';
  if (!tenant.bridge.workspaceLabel) return 'workspace-missing';
  return 'ready';
}

function tenantBridgeStatusLabel(tenant: TenantRuntimeItem) {
  const state = tenantBridgeState(tenant);
  if (state === 'ready') return 'Bridge 在线';
  if (state === 'workspace-missing') return 'Bridge 在线';
  if (state === 'offline') return 'Bridge 离线';
  return '未配置 Bridge';
}

export function RuntimeConsole() {
  const [view, setView] = useState<
    'runtimes' | 'employees' | 'capabilities' | 'governance' | 'tenants'
  >('runtimes');
  const [data, setData] = useState<RuntimeConsoleResponse | null>(null);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [timeline, setTimeline] = useState<
    RuntimeTimelineResponse['timeline'] | null
  >(null);
  const [timelineError, setTimelineError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view');
    if (
      requested === 'runtimes' ||
      requested === 'employees' ||
      requested === 'capabilities' ||
      requested === 'governance' ||
      requested === 'tenants'
    ) {
      setView(requested);
    }
  }, []);

  const selectView = useCallback(
    (
      next:
        'runtimes' | 'employees' | 'capabilities' | 'governance' | 'tenants',
    ) => {
      setView(next);
      const url = new URL(window.location.href);
      url.searchParams.set('view', next);
      window.history.replaceState(null, '', url);
    },
    [],
  );

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
    setSelectedTenantId((current) =>
      current && next.tenants.some((item) => item.workspace.id === current)
        ? current
        : (next.tenants[0]?.workspace.id ?? null),
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
    if (!data || !selectedTenantId) {
      setSelectedId(null);
      return;
    }
    const tenantRuntimes = data.runtimes.filter(
      (item) => item.workspace.id === selectedTenantId,
    );
    setSelectedId((current) =>
      current && tenantRuntimes.some((item) => item.session.id === current)
        ? current
        : (tenantRuntimes[0]?.session.id ?? null),
    );
  }, [data, selectedTenantId]);

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
  const selectedTenant = useMemo(
    () =>
      data?.tenants.find((item) => item.workspace.id === selectedTenantId) ??
      null,
    [data, selectedTenantId],
  );
  const tenantRuntimes = useMemo(
    () =>
      data?.runtimes.filter((item) => item.workspace.id === selectedTenantId) ??
      [],
    [data, selectedTenantId],
  );
  const running = data?.runtimes.filter(
    (item) => item.process?.status === 'live',
  ).length;
  const onlineBridges = data?.tenants.filter(
    (item) => item.bridge?.status === 'online',
  ).length;
  const totalSessions = data?.tenants.reduce(
    (total, tenant) => total + tenant.sessions.total,
    0,
  );
  const projectedTurns = useMemo(() => {
    return (timeline?.turns ?? []).map((turn) => {
      const answerEvent = [...turn.events]
        .reverse()
        .find((event) => event.kind === 'answer' && event.detail);
      return {
        ...turn,
        items: aggregateRuntimeTimelineEvents(
          turn.events.filter((event) => event.kind !== 'answer'),
        ),
        answerText: answerEvent?.detail ?? turn.assistantMessage.text,
      };
    });
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
      </header>

      <DshReleaseSummary
        onOpenCapabilities={() => selectView('capabilities')}
      />

      <nav className={styles.viewNav} aria-label="Runtime Console 菜单">
        <button
          aria-current={view === 'tenants' ? 'page' : undefined}
          onClick={() => selectView('tenants')}
        >
          租户管理
        </button>
        <button
          aria-current={view === 'employees' ? 'page' : undefined}
          onClick={() => selectView('employees')}
        >
          AI 员工
        </button>
        <button
          aria-current={view === 'runtimes' ? 'page' : undefined}
          onClick={() => selectView('runtimes')}
        >
          Runtime 状态
        </button>
        <button
          aria-current={view === 'capabilities' ? 'page' : undefined}
          onClick={() => selectView('capabilities')}
        >
          版本与能力
        </button>
        <button
          aria-current={view === 'governance' ? 'page' : undefined}
          onClick={() => selectView('governance')}
        >
          模型治理
        </button>
      </nav>

      {view === 'tenants' ? (
        <TenantAdministration />
      ) : view === 'employees' ? (
        <EmployeeProduction />
      ) : view === 'capabilities' ? (
        <CapabilitySourceView onOpenEmployees={() => selectView('employees')} />
      ) : view === 'governance' ? (
        <GovernanceConsole />
      ) : (
        <>
          <section className={styles.summary}>
            <div>
              <span>租户</span>
              <strong>{data?.tenants.length ?? 0}</strong>
            </div>
            <div>
              <span>Session</span>
              <strong>{totalSessions ?? 0}</strong>
            </div>
            <div>
              <span>活跃 Runtime</span>
              <strong>{running ?? 0}</strong>
            </div>
            <div>
              <span>在线 Bridge</span>
              <strong>{onlineBridges ?? 0}</strong>
            </div>
            <p>
              {updatedAt
                ? `最近刷新 ${time(updatedAt.toISOString())}`
                : '正在连接事实源…'}
            </p>
          </section>

          {error ? <p className={styles.error}>{error}</p> : null}
          <section className={styles.tenantOverview}>
            <header className={styles.tenantOverviewHeader}>
              <div>
                <p>Tenant Runtime</p>
                <h1>租户运行状态</h1>
                <span>
                  先选择租户，再查看该租户的 Session、Worker、模型与事件明细。
                  每张卡片同时展示该租户的 Bridge、心跳和本地工作区状态。
                </span>
              </div>
              <strong>{data?.tenants.length ?? 0} 个租户</strong>
            </header>
            <div className={styles.tenantGrid}>
              {data?.tenants.map((tenant) => (
                <button
                  className={styles.tenantCard}
                  data-selected={
                    tenant.workspace.id === selectedTenantId
                      ? 'true'
                      : undefined
                  }
                  key={tenant.workspace.id}
                  onClick={() => setSelectedTenantId(tenant.workspace.id)}
                >
                  <header>
                    <span>
                      <strong>{tenant.organization.name}</strong>
                      <small>{tenant.workspace.name}</small>
                    </span>
                    <em data-state={tenantBridgeState(tenant)}>
                      {tenantBridgeStatusLabel(tenant)}
                    </em>
                  </header>
                  <dl>
                    <div>
                      <dt>Session</dt>
                      <dd>{tenant.sessions.total}</dd>
                    </div>
                    <div>
                      <dt>Runtime</dt>
                      <dd>{tenant.sessions.runtimeBound}</dd>
                    </div>
                    <div>
                      <dt>活跃</dt>
                      <dd>{tenant.sessions.active}</dd>
                    </div>
                    <div>
                      <dt>异常</dt>
                      <dd>{tenant.sessions.error}</dd>
                    </div>
                  </dl>
                  <div className={styles.tenantBridge}>
                    {tenant.bridge ? (
                      <>
                        <div className={styles.tenantBridgeDevice}>
                          <strong>{tenant.bridge.name}</strong>
                          <small>
                            {tenant.bridge.platform} · 最后心跳{' '}
                            {time(tenant.bridge.lastSeenAt)}
                          </small>
                        </div>
                        {tenant.bridge.status === 'online' ? (
                          <div className={styles.tenantBridgeWorkspace}>
                            <span>本地工作区</span>
                            <strong
                              data-state={
                                tenant.bridge.workspaceLabel
                                  ? 'selected'
                                  : 'missing'
                              }
                            >
                              {tenant.bridge.workspaceLabel ?? '未选择工作区'}
                            </strong>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className={styles.tenantBridgeEmpty}>
                        租户尚未配对本地 Bridge；云端 Runtime 不受影响。
                      </p>
                    )}
                  </div>
                </button>
              ))}
              {data && data.tenants.length === 0 ? (
                <p className={styles.tenantEmpty}>当前没有有效租户。</p>
              ) : null}
            </div>
          </section>

          <div className={styles.content}>
            <aside className={styles.sidebar}>
              <header>
                <strong>Session Runtime</strong>
                <small>{tenantRuntimes.length}</small>
              </header>
              <div className={styles.runtimeList}>
                {tenantRuntimes.map((item) => (
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
                        {item.session.employeeName ?? 'AI 员工'} ·{' '}
                        {item.owner.email}
                      </small>
                    </span>
                    <em>{runtimeStateLabel(item)}</em>
                  </button>
                ))}
                {data && selectedTenant && tenantRuntimes.length === 0 ? (
                  <p className={styles.empty}>
                    这个租户还没有绑定 DSH Runtime 的 Session。
                  </p>
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
                      data-state={
                        selected.process?.status === 'live'
                          ? 'running'
                          : selected.runtime.state
                      }
                    >
                      {runtimeStateLabel(selected)}
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
                          <dd>
                            {selected.runtime.workerId ?? '当前无活跃租约'}
                          </dd>
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
                          <dd>
                            {selected.provider?.reasoningEffort ?? 'unknown'}
                          </dd>
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
                          <dd>
                            {selected.process?.nativeTools.join(', ') || '—'}
                          </dd>
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
                        <strong>Session 完整对话与事件</strong>
                        <span>
                          全部 {projectedTurns.length} 轮 · 按 Harness 原始顺序
                          · 1.5 秒刷新
                        </span>
                      </div>
                      <em data-state={timeline?.run?.status ?? 'idle'}>
                        {timeline?.run?.status ?? 'no run'}
                      </em>
                    </header>
                    {timelineError ? (
                      <p className={styles.timelineError}>{timelineError}</p>
                    ) : projectedTurns.length ? (
                      <div className={styles.turnList}>
                        {projectedTurns.map((turn, index) => (
                          <RuntimeTurn
                            key={turn.run.id}
                            turn={turn}
                            number={index + 1}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className={styles.timelineEmpty}>
                        这个 Session 还没有租户对话。
                      </p>
                    )}
                  </article>

                  <aside className={styles.notice}>
                    事件来自真实 Worker Runtime。ChatFlow
                    仅负责租户边界、持久化和
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
        </>
      )}
    </main>
  );
}

function RuntimeTurn(props: {
  number: number;
  turn: RuntimeTimelineTurn & {
    items: RuntimeTimelineItem[];
    answerText: string | null;
  };
}) {
  return (
    <section className={styles.turn}>
      <header className={styles.turnHeader}>
        <div>
          <strong>第 {props.number} 轮</strong>
          <span>Run {props.turn.run.id.slice(0, 8)}</span>
        </div>
        <div>
          <em data-state={props.turn.run.status}>{props.turn.run.status}</em>
          <time>{time(props.turn.run.createdAt)}</time>
        </div>
      </header>

      <RunUsageSummary
        usage={props.turn.usage}
        runStatus={props.turn.run.status}
      />
      <RunTimingSummary timing={props.turn.timing} />

      <div className={styles.dialogueMessage} data-role="user">
        <span>租户</span>
        <p>{props.turn.userMessage.text ?? '（没有可展示的文本）'}</p>
        <time>{time(props.turn.userMessage.occurredAt)}</time>
      </div>

      {props.turn.items.length ? (
        <ol className={styles.eventList}>
          {props.turn.items.map((item) => (
            <RuntimeEventItem item={item} key={item.key} />
          ))}
        </ol>
      ) : null}

      <div className={styles.dialogueMessage} data-role="assistant">
        <span>Rice</span>
        <p>{props.turn.answerText ?? '（本轮还没有回复文本）'}</p>
        <time>{time(props.turn.assistantMessage.occurredAt)}</time>
      </div>
    </section>
  );
}

function RuntimeEventItem(props: { item: RuntimeTimelineItem }) {
  if (props.item.type === 'event') {
    return <RuntimeEvent event={props.item.event} />;
  }
  return (
    <li className={styles.eventGroup} data-kind={props.item.kind}>
      <i>G</i>
      <div>
        <details>
          <summary>
            <span>
              <strong>{props.item.title}</strong>
              <em>{props.item.status}</em>
            </span>
            <small>展开明细</small>
          </summary>
          <ol>
            {props.item.events.map((event) => (
              <li key={event.key}>
                <span>{event.detail ?? event.title}</span>
                <em>{event.title}</em>
              </li>
            ))}
          </ol>
        </details>
      </div>
      <time>{time(props.item.occurredAt)}</time>
    </li>
  );
}

function RuntimeEvent(props: { event: RuntimeTimelineEvent }) {
  return (
    <li data-kind={props.event.kind}>
      <i>{props.event.kind.slice(0, 1).toUpperCase()}</i>
      <div>
        <span>
          <strong>{props.event.title}</strong>
          <em>{props.event.status}</em>
        </span>
        {props.event.detail ? <p>{props.event.detail}</p> : null}
      </div>
      <time>{time(props.event.occurredAt)}</time>
    </li>
  );
}

function CapabilityGroupCard(props: { group: RuntimeCapabilityCatalogGroup }) {
  return (
    <article
      className={styles.capabilityGroup}
      data-source={props.group.source}
    >
      <header>
        <div>
          <h2>{props.group.title}</h2>
          <p>{props.group.description}</p>
        </div>
        <span>{props.group.badge}</span>
      </header>
      <ul>
        {props.group.items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.name}</strong>
              {item.packageName ? <code>{item.packageName}</code> : null}
              <p>{item.detail}</p>
            </div>
            <span>{item.policy}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function CapabilitySourceView(props: { onOpenEmployees: () => void }) {
  const [coreOpen, setCoreOpen] = useState(false);
  const [inventory, setInventory] = useState<RuntimeCapabilityResponse | null>(
    null,
  );
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState('');
  const allrice = runtimeCapabilityCatalog.find(
    (group) => group.source === 'allrice',
  );
  const blocked = runtimeCapabilityCatalog.find(
    (group) => group.source === 'blocked',
  );
  const facts = runtimeCapabilityFacts(inventory);
  const { availableSkills } = facts;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(
          '/api/v1/admin/runtime-console/capabilities',
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(8_000),
            ]),
          },
        );
        if (response.status === 401) {
          window.location.assign(
            `/login?next=${encodeURIComponent('/runtime-console?view=capabilities')}`,
          );
          return;
        }
        if (!response.ok) throw Error(`能力状态读取失败（${response.status}）`);
        const body = (await response.json()) as RuntimeCapabilityResponse;
        if (!active) return;
        setInventory(body);
        setSkillsError('');
      } catch (error) {
        if (!active) return;
        setInventory(null);
        setSkillsError(
          error instanceof Error ? error.message : '能力状态读取失败',
        );
      } finally {
        if (active) {
          setSkillsLoading(false);
          timer = setTimeout(() => void refresh(), 10_000);
        }
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!coreOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCoreOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [coreOpen]);

  return (
    <section className={styles.capabilityPage}>
      <header className={styles.capabilityHeader}>
        <div>
          <p>DSH 升级与 AllRice 能力</p>
          <h1>版本与能力</h1>
          <span>
            按当前 Worker 安装与配置、平台 Skill 目录和租户员工发布版本展示。每
            10 秒刷新。
          </span>
        </div>
        <aside>
          <strong>{facts.componentCount}</strong>
          <span>已安装配置组件 / Worker</span>
          <strong>{facts.enhancementCount}</strong>
          <span>其中增强插件 / Worker</span>
          <strong>{inventory ? availableSkills.length : '—'}</strong>
          <span>可绑定业务 Skill</span>
          <strong>{inventory ? facts.publishedSkillIds.size : '—'}</strong>
          <span>租户员工已发布 Skill</span>
        </aside>
      </header>

      <p
        className={styles.capabilityStatus}
        data-error={skillsError || !facts.measured ? 'true' : undefined}
        role="status"
      >
        {skillsLoading
          ? '正在读取实际能力状态…'
          : skillsError ||
            `${facts.workers.length} 个在线 Worker · 数据更新于 ${time(inventory?.checkedAt ?? null)}${!facts.measured ? ' · 运行配置未知或心跳已过期' : ''}`}
      </p>
      <DshUpgradeCapabilities
        onOpenEmployees={props.onOpenEmployees}
        inventory={inventory}
      />

      <div className={styles.capabilityTaxonomy}>
        <article>
          <strong>Runtime 组件</strong>
          <span>
            驱动 Agent、Session、模型调用和上下文管理，随 Runtime 运行。
          </span>
        </article>
        <article>
          <strong>Tool</strong>
          <span>提供可执行动作，每次调用都由 AllRice 按租户权限重新授权。</span>
        </article>
        <article>
          <strong>业务 Skill</strong>
          <span>
            告诉 Rice 何时、按什么方法工作，但不会自行扩大 Tool 权限。
          </span>
        </article>
      </div>

      <section className={styles.coreOverview}>
        <div>
          <span>DSH Restricted Runtime</span>
          <h2>{facts.componentCount} 个已安装配置组件 / Worker</h2>
          <p>
            读取 Worker 当前配置文件和本机安装包版本；表示新任务的组件配置，
            不等同于空闲时已有 DSH 进程装载。增强插件包含在组件总数内。
          </p>
        </div>
        <button type="button" onClick={() => setCoreOpen(true)}>
          查看实际组件
        </button>
      </section>

      <div className={styles.capabilityGroups}>
        <article className={styles.capabilityGroup}>
          <header>
            <div>
              <h2>租户员工实际发布</h2>
              <p>
                统计当前生效的用户分配版本；Skill 数量按 ID
                去重。已发布仍需在任务内校验成员权限、设备连接和具体操作授权。
              </p>
            </div>
          </header>
          <ul>
            {inventory?.publications.map((item) => (
              <li
                key={`${item.workspaceId}:${item.employeeName}:${item.version}`}
              >
                <div>
                  <strong>
                    {item.workspaceName} · {item.employeeName} v{item.version}
                  </strong>
                  <p>
                    {item.skillIds.length} 个 Skill · {item.toolNames.length}{' '}
                    个工具
                  </p>
                </div>
                <span>
                  {item.policyEnabled && item.policyMode === 'execute'
                    ? '执行策略已开启'
                    : '执行策略未开启'}
                </span>
              </li>
            ))}
          </ul>
          {!inventory?.publications.length ? (
            <p className={styles.capabilityStatus}>
              {inventory ? '暂无生效的租户员工发布' : '发布状态未知'}
            </p>
          ) : null}
        </article>
        {allrice ? <CapabilityGroupCard group={allrice} /> : null}

        <article className={styles.capabilityGroup} data-source="skills">
          <header>
            <div>
              <h2>平台业务 Skill 目录</h2>
              <p>
                Skill 是给 Employee 的工作方法，不是 DSH
                插件。这里显示平台已审核且可用的目录；只有绑定并发布给 Employee
                后，才会进入对应租户 Runtime。
              </p>
            </div>
            <button
              className={styles.groupAction}
              type="button"
              onClick={props.onOpenEmployees}
            >
              前往 AI 员工装配
            </button>
          </header>
          {skillsLoading ? (
            <p className={styles.capabilityStatus}>正在读取平台 Skill 目录…</p>
          ) : skillsError ? (
            <p className={styles.capabilityStatus} data-error="true">
              {skillsError}
            </p>
          ) : availableSkills.length ? (
            <ul>
              {availableSkills.map((skill) => (
                <li key={skill.id}>
                  <div>
                    <strong>{skill.name}</strong>
                    <code>
                      {skill.version} · {skill.checksum.slice(0, 20)}…
                    </code>
                    <p>
                      {skill.description}
                      {skill.requiredToolRefs.length
                        ? ` 所需 Tool：${skill.requiredToolRefs.join('、')}。`
                        : ' 不依赖额外 Tool。'}
                    </p>
                  </div>
                  <span>
                    {facts.publishedSkillIds.has(skill.id)
                      ? '已发布到租户员工'
                      : '目录可用 · 尚未发布'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.capabilityStatus}>
              当前没有可绑定的业务 Skill。
            </p>
          )}
        </article>

        {blocked ? <CapabilityGroupCard group={blocked} /> : null}
      </div>

      <footer className={styles.capabilityFooter}>
        测试阶段升级能力默认开放，发现问题及时修复。此页如实显示当前安装、配置与发布状态，
        “未开启”或“未发布”代表仍需落实的开放项。
      </footer>

      {coreOpen ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCoreOpen(false);
          }}
        >
          <section
            aria-labelledby="dsh-core-title"
            aria-modal="true"
            className={styles.coreModal}
            role="dialog"
          >
            <header>
              <div>
                <span>DSH Restricted Runtime</span>
                <h2 id="dsh-core-title">Worker 实际配置组件</h2>
                <p>
                  逐个 Worker
                  显示安装版本和配置状态；停用、条件加载及缺失的组件不计入已配置总数。
                </p>
              </div>
              <button
                aria-label="关闭实际组件弹窗"
                type="button"
                onClick={() => setCoreOpen(false)}
              >
                ×
              </button>
            </header>
            {inventory?.workers.map((worker) => (
              <div key={worker.workerId}>
                <p className={styles.capabilityStatus}>
                  Worker {worker.workerId.slice(0, 8)} · DSH{' '}
                  {worker.version ?? '未知'} ·{' '}
                  {worker.online ? '在线' : '心跳过期'} ·{' '}
                  {time(worker.observedAt)} ·{' '}
                  {worker.releaseSha?.slice(0, 7) ?? '构建未知'}
                </p>
                {worker.profileStatus !== 'read' ? (
                  <p className={styles.capabilityStatus}>当前配置无法核实</p>
                ) : null}
                <ul>
                  {worker.components.map((component) => (
                    <li key={component.id}>
                      <div>
                        <strong>{component.id}</strong>
                        <code>
                          {component.packageName} ·{' '}
                          {component.version ?? '未安装'}
                        </code>
                      </div>
                      <span>
                        {!worker.online
                          ? '历史记录'
                          : {
                              configured: '已安装 · 已配置',
                              disabled: '配置已停用',
                              conditional: '条件加载 · 待运行核实',
                              missing: '安装包缺失',
                            }[component.state]}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!inventory?.workers.length ? (
              <p className={styles.capabilityStatus}>暂无 Worker 上报</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}
