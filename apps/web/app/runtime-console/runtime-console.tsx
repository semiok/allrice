'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { GovernanceConsole } from './governance-console';
import { TenantAdministration } from './tenant-administration';
import { RunUsageSummary } from './run-usage';
import {
  dshRuntimeCoreComponents,
  runtimeCapabilityCatalog,
  type RuntimeCapabilityCatalogGroup,
} from './runtime-capability-catalog';
import { EmployeeProduction } from './employee-production';
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

interface PlatformNativeSkillSummary {
  id: string;
  name: string;
  description: string;
  checksum: string;
  requiredToolRefs: string[];
  enabled: boolean;
  version: string;
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
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
          能力来源
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
  const [skills, setSkills] = useState<PlatformNativeSkillSummary[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState('');
  const dshPlugins = runtimeCapabilityCatalog.find(
    (group) => group.source === 'dsh-plugin',
  );
  const allrice = runtimeCapabilityCatalog.find(
    (group) => group.source === 'allrice',
  );
  const blocked = runtimeCapabilityCatalog.find(
    (group) => group.source === 'blocked',
  );
  const availableSkills = skills.filter(
    (skill) => skill.enabled && skill.reviewStatus === 'reviewed',
  );

  useEffect(() => {
    let active = true;
    const loadSkills = async () => {
      const response = await fetch('/api/v1/admin/platform-employees', {
        cache: 'no-store',
      });
      if (response.status === 401) {
        window.location.assign(
          `/login?next=${encodeURIComponent('/runtime-console?view=capabilities')}`,
        );
        return;
      }
      const body = (await response.json().catch(() => null)) as {
        skills?: PlatformNativeSkillSummary[];
        error?: { message?: string };
      } | null;
      if (!response.ok) {
        throw new Error(
          body?.error?.message ?? `业务 Skill 加载失败（${response.status}）`,
        );
      }
      if (!active) return;
      setSkills(body?.skills ?? []);
      setSkillsError('');
      setSkillsLoading(false);
    };
    void loadSkills().catch((reason: unknown) => {
      if (!active) return;
      setSkillsError(
        reason instanceof Error ? reason.message : '业务 Skill 加载失败',
      );
      setSkillsLoading(false);
    });
    return () => {
      active = false;
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
          <p>Runtime 组件、Tool 与 Skill 边界</p>
          <h1>能力来源</h1>
          <span>
            DSH 提供 Agent 执行引擎，AllRice 负责租户权限、Tool 与业务 Skill
            发布。DSH Lab 中手动安装的内容不会自动进入租户 Runtime。
          </span>
        </div>
        <aside>
          <strong>{dshRuntimeCoreComponents.length}</strong>
          <span>DSH 基础组件</span>
          <strong>{dshPlugins?.items.length ?? 0}</strong>
          <span>准入增强插件</span>
          <strong>{skillsLoading ? '—' : availableSkills.length}</strong>
          <span>可绑定业务 Skill</span>
          <strong>{blocked?.items.length ?? 0}</strong>
          <span>默认禁止能力</span>
        </aside>
      </header>

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
          <h2>{dshRuntimeCoreComponents.length} 个基础组件正在装载使用</h2>
          <p>
            包括 Agent Loop、Provider 路由、Session 持久化、Token
            计量、基础压缩和受控 Skill
            加载机制。部分组件每轮必经，部分按条件触发。
          </p>
        </div>
        <button type="button" onClick={() => setCoreOpen(true)}>
          查看基础组件
        </button>
      </section>

      <div className={styles.capabilityGroups}>
        {dshPlugins ? <CapabilityGroupCard group={dshPlugins} /> : null}
        {allrice ? <CapabilityGroupCard group={allrice} /> : null}

        <article className={styles.capabilityGroup} data-source="skills">
          <header>
            <div>
              <h2>AllRice 审核发布的业务 Skill</h2>
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
                  <span>平台已准入 · 按员工绑定</span>
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
        正式路径：DSH Lab 发现候选 → 管理端验证 → 安全与许可证审核 → 固定版本 →
        AllRice 发布 → 绑定 Employee → 下一次 Run 冻结生效。DSH Lab
        的手动安装不会直接进入生产租户。
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
                <h2 id="dsh-core-title">正在使用的基础组件</h2>
                <p>
                  以下组件固定编入当前 Runtime。它们是执行机制，不是业务 Skill。
                </p>
              </div>
              <button
                aria-label="关闭基础组件弹窗"
                type="button"
                onClick={() => setCoreOpen(false)}
              >
                ×
              </button>
            </header>
            <ul>
              {dshRuntimeCoreComponents.map((component) => (
                <li key={component.id}>
                  <div>
                    <strong>{component.name}</strong>
                    <code>{component.packageName}</code>
                    <p>{component.detail}</p>
                  </div>
                  <span>{component.policy}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </section>
  );
}
