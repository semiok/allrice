'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminTenantMember,
  AdminTenantMembers,
  AdminTenantQuotas,
  AdminTenantQuota,
  AdminTenantEnvironments,
  TenantQuotaLimits,
} from '@allrice/contracts';
import {
  capabilityLabels,
  capabilityReasons,
  capabilityStateLabels,
} from '../chatflow/capability-catalog';
import { McpSettings } from './mcp-settings';
import { LocalMcpSettings } from './local-mcp-settings';
import { TenantValidation } from './tenant-validation';
import styles from './tenant-administration.module.css';

export type TenantResourceProps = {
  organizationId: string;
  workspaceId: string;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
};
export type ManagedConnectorProps = {
  organizationId: string;
  subjectId: string;
  reason: string;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
};
async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => {
    throw Error('管理接口未返回有效数据，请检查服务版本或稍后刷新。');
  });
  if (!response.ok)
    throw Error(
      body.error?.message ??
        (body.code === 'CONFLICT'
          ? '配置已变化，请刷新后重试。'
          : '读取或保存未完成，请核对权限及配置。'),
    );
  return body;
}

export function TenantResourceEditor(
  props: TenantResourceProps & {
    mode: 'quotas' | 'environments' | 'validation';
  },
) {
  const [members, setMembers] = useState<AdminTenantMember[]>([]),
    [subjectId, setSubjectId] = useState(''),
    [error, setError] = useState('');
  const [next, setNext] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const { organizationId, workspaceId, onBusy, onDirty } = props;
  const request = useRef<AbortController | null>(null);
  const initialSubject = useRef(false);
  const load = useCallback(
    async (after?: string) => {
      request.current?.abort();
      const c = new AbortController();
      request.current = c;
      setLoading(true);
      setError('');
      try {
        const data = await json<AdminTenantMembers>(
          await fetch(
            `/api/v1/admin/tenants/${organizationId}?workspaceId=${workspaceId}${after ? `&after=${after}` : ''}`,
            { cache: 'no-store', signal: c.signal },
          ),
        );
        if (c.signal.aborted) return;
        if (
          data.organizationId !== organizationId ||
          data.workspaceId !== workspaceId
        )
          throw Error('返回范围不匹配，已拒绝显示。');
        setMembers((old) =>
          after
            ? [
                ...old,
                ...data.members.filter((m) => !old.some((o) => o.id === m.id)),
              ]
            : data.members,
        );
        setNext(data.nextCursor);
        if (!initialSubject.current) {
          const params = new URLSearchParams(window.location.search);
          const requested = params.get('subjectId');
          if (
            params.get('organizationId') === organizationId &&
            params.get('workspaceId') === workspaceId &&
            data.members.some(
              (m) =>
                m.userId === requested && m.active && m.userStatus === 'active',
            )
          ) {
            setSubjectId(requested!);
            initialSubject.current = true;
          }
        }
      } catch (e) {
        if (!c.signal.aborted)
          setError(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    },
    [organizationId, workspaceId],
  );
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const users = members.filter(
    (m, i, a) =>
      m.active &&
      m.userStatus === 'active' &&
      a.findIndex((o) => o.active && o.userId === m.userId) === i,
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || busy) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, busy]);
  return (
    <section
      aria-label={
        props.mode === 'quotas'
          ? '分层额度管理'
          : props.mode === 'validation'
            ? '租户验收管理'
            : '环境与连接器管理'
      }
    >
      <label>
        实际使用者
        <select
          aria-label="实际使用者"
          value={subjectId}
          disabled={loading || busy}
          onChange={(e) => {
            if (
              !dirty ||
              window.confirm('切换使用者将放弃未保存修改，是否继续？')
            ) {
              setDirty(false);
              initialSubject.current = true;
              setSubjectId(e.target.value);
            }
          }}
        >
          <option value="">请选择使用者（不会切换登录身份）</option>
          {users.map((u) => (
            <option key={u.userId} value={u.userId}>
              {u.displayName} · {u.email}
            </option>
          ))}
        </select>
      </label>
      {next ? (
        <button disabled={busy || loading} onClick={() => void load(next)}>
          加载更多使用者
        </button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {subjectId ? (
        <>
          <p>
            管理员仍使用自己的身份操作；授权使用者：
            {users.find((u) => u.userId === subjectId)?.displayName}
            。不更改其成员角色。
          </p>
          {props.mode === 'quotas' ? (
            <Quotas
              key={subjectId}
              {...props}
              subjectId={subjectId}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          ) : props.mode === 'validation' ? (
            <TenantValidation
              key={subjectId}
              {...props}
              subjectId={subjectId}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          ) : (
            <Environments
              key={subjectId}
              {...props}
              subjectId={subjectId}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          )}
        </>
      ) : (
        <p>
          选择使用者后查看其生效配置。此处不提供冒用身份或自动授权设备的操作。
        </p>
      )}
    </section>
  );
}

type ScopedProps = TenantResourceProps & { subjectId: string };
function Quotas({
  organizationId,
  workspaceId,
  subjectId,
  onDirty,
  onBusy,
}: ScopedProps) {
  const [data, setData] = useState<AdminTenantQuotas | null>(null),
    [scope, setScope] = useState<AdminTenantQuota['scope']>('user'),
    [limits, setLimits] = useState<TenantQuotaLimits | null>(null),
    [reason, setReason] = useState(''),
    [inherit, setInherit] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const endpoint = `/api/v1/admin/tenants/${organizationId}/quotas`,
    latest = useRef<AbortController | null>(null);
  const row = data?.quotas.find((q) => q.scope === scope);
  const accept = (value: AdminTenantQuotas) => {
    if (
      value.organizationId !== organizationId ||
      value.workspaceId !== workspaceId ||
      value.subjectId !== subjectId
    )
      throw Error('返回范围不匹配，已拒绝显示。');
    return value;
  };
  async function load() {
    latest.current?.abort();
    const c = new AbortController();
    latest.current = c;
    setBusy(true);
    setError('');
    try {
      const next = accept(
        await json<AdminTenantQuotas>(
          await fetch(
            `${endpoint}?workspaceId=${workspaceId}&subjectId=${subjectId}`,
            { cache: 'no-store', signal: c.signal },
          ),
        ),
      );
      if (c.signal.aborted) return;
      setData(next);
      setLimits({ ...next.quotas.find((q) => q.scope === scope)!.effective });
      setReason('');
      setInherit(false);
      setDirty(false);
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e instanceof Error ? e.message : '加载失败');
        setData(null);
      }
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => latest.current?.abort();
  }, [endpoint, workspaceId, subjectId]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  const labels = {
    organization: '组织总额度（所有工作区）',
    tenant: '租户资源限额',
    user: '所选用户限额',
  };
  async function save() {
    if (!row || !limits || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = accept(
        await json<AdminTenantQuotas>(
          await fetch(endpoint, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId,
              subjectId,
              scope,
              expectedVersion: row.version,
              limits: inherit ? null : limits,
              reason,
            }),
          }),
        ),
      );
      setData(value);
      setLimits({ ...value.quotas.find((q) => q.scope === scope)!.effective });
      setDirty(false);
      setReason('');
      setInherit(false);
      setNotice('额度已保存；真实用量、未知预留和 Codex 官方额度未被改写。');
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : '保存状态未知，请刷新核对，不要重复提交。',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <h3>用量统计与资源限制</h3>
      <p>
        {data?.subscription.tokenPolicy === 'observe'
          ? 'Codex 订阅不按内部 Token 限额拦截。下方保留 API 额度配置；并发、运行时长和请求次数限制仍用于保护服务。'
          : '组织总额度、租户资源限额和用户限额共同约束新任务；提高用户额度不会绕过组织额度。员工/Provider 限额仍由原运行准入检查。'}
      </p>
      <button
        disabled={busy}
        onClick={() => {
          if (!dirty || window.confirm('刷新将放弃未保存修改，是否继续？'))
            void load();
        }}
      >
        刷新额度
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {data ? (
        <>
          <p>
            统计周期：{new Date(data.periodStart).toLocaleDateString()} 至{' '}
            {new Date(data.resetsAt).toLocaleDateString()}
            。缓存是输入的一部分，已计入总量，不重复相加。未知不是 0。
          </p>
          <h4>用量统计（真实只读记录）</h4>
          <div className={styles.tableScroll}>
            <table>
              <thead>
                <tr>
                  <th>限额层级</th>
                  <th>
                    来源 /{' '}
                    {data.subscription.tokenPolicy === 'observe'
                      ? 'API'
                      : '生效'}{' '}
                    Token 上限
                  </th>
                  <th>已记录总量 / 其中缓存</th>
                  <th>月模型调用统计</th>
                  <th>未知用量 / 风险预留</th>
                </tr>
              </thead>
              <tbody>
                {data.quotas.map((q) => (
                  <tr key={q.scope}>
                    <td>
                      {labels[q.scope]}
                      <small>
                        {q.usageScope === 'organization'
                          ? '全组织月累计'
                          : '当前工作区月累计'}
                      </small>
                    </td>
                    <td>
                      {q.source === 'tenant_override'
                        ? '显式覆盖'
                        : q.source === 'platform_override'
                          ? '继承平台对象配置'
                          : '继承平台默认'}
                      <br />
                      {q.effective.monthlyTokenLimit.toLocaleString()}
                    </td>
                    <td>
                      {q.usedTokens.toLocaleString()} /{' '}
                      {q.cachedInputTokens === null
                        ? '未知'
                        : q.cachedInputTokens.toLocaleString()}
                    </td>
                    <td>
                      {q.usedRuns.toLocaleString()} 次
                      {data.subscription.tokenPolicy === 'observe' ? (
                        <small>观察模式 · 不阻断准入</small>
                      ) : null}
                    </td>
                    <td>
                      {q.unknownUsageRuns} 笔 /{' '}
                      {q.reservedTokens.toLocaleString()} Token
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>{data.subscription.message}</p>
          <h4>运行保护配置</h4>
          <label>
            调整对象
            <select
              aria-label="调整额度对象"
              disabled={busy}
              value={scope}
              onChange={(e) => {
                if (
                  dirty &&
                  !window.confirm('切换对象将放弃未保存修改，是否继续？')
                )
                  return;
                const v = e.target.value as AdminTenantQuota['scope'];
                setScope(v);
                setLimits({
                  ...data.quotas.find((q) => q.scope === v)!.effective,
                });
                setInherit(false);
                setReason('');
                setDirty(false);
              }}
            >
              {Object.entries(labels).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {row && limits ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={busy}>
                {scope !== 'organization' ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={inherit}
                      onChange={(e) => {
                        setInherit(e.target.checked);
                        setDirty(true);
                      }}
                    />
                    移除此租户对象覆盖，恢复平台配置/默认值（不清除账本）
                  </label>
                ) : (
                  <p>
                    此处只修改组织月 Token
                    与调用次数；组织美分限额保持原值，订阅不据此推算费用。
                  </p>
                )}
                {scope !== 'organization' ? (
                  <label>
                    任务有效运行时限
                    <select
                      aria-label="任务有效运行时限"
                      value={limits.maxRuntimeMs}
                      disabled={inherit}
                      onChange={(e) => {
                        setLimits({
                          ...limits,
                          maxRuntimeMs: Number(e.target.value),
                        });
                        setDirty(true);
                      }}
                    >
                      <option value={1_800_000}>30 分钟</option>
                      <option value={3_600_000}>1 小时（推荐默认）</option>
                      <option value={0}>不限制</option>
                      {![1_800_000, 3_600_000, 0].includes(
                        limits.maxRuntimeMs,
                      ) && (
                        <option value={limits.maxRuntimeMs}>
                          自定义（{limits.maxRuntimeMs} 毫秒）
                        </option>
                      )}
                    </select>
                  </label>
                ) : null}
                {(
                  (scope === 'organization'
                    ? ['monthlyTokenLimit', 'monthlyRunLimit']
                    : [
                        'monthlyTokenLimit',
                        'monthlyRunLimit',
                        'concurrentRunLimit',
                      ]) as (
                    | 'monthlyTokenLimit'
                    | 'monthlyRunLimit'
                    | 'concurrentRunLimit'
                  )[]
                ).map((key) => (
                  <label key={key}>
                    {
                      {
                        monthlyTokenLimit: '月 Token 上限',
                        monthlyRunLimit: '月模型调用次数上限',
                        concurrentRunLimit: '并发运行上限',
                      }[key]
                    }
                    <input
                      aria-label={
                        {
                          monthlyTokenLimit: '月 Token 上限',
                          monthlyRunLimit: '月模型调用次数上限',
                          concurrentRunLimit: '并发运行上限',
                        }[key]
                      }
                      type="number"
                      required
                      min={1}
                      step="1"
                      value={limits[key]}
                      disabled={inherit}
                      onChange={(e) => {
                        setLimits({ ...limits, [key]: Number(e.target.value) });
                        setDirty(true);
                      }}
                    />
                  </label>
                ))}
                <label>
                  修改原因
                  <input
                    aria-label="额度修改原因"
                    required
                    minLength={5}
                    maxLength={500}
                    value={reason}
                    onChange={(e) => {
                      setReason(e.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <button disabled={!dirty || reason.trim().length < 5}>
                  保存额度
                </button>
              </fieldset>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Environments(props: ScopedProps) {
  const { organizationId, workspaceId, subjectId, onBusy, onDirty } = props;
  const [data, setData] = useState<AdminTenantEnvironments | null>(null),
    [section, setSection] = useState<'environment' | 'mcp' | 'local-mcp'>(
      'environment',
    ),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [kind, setKind] = useState<
      'cloud_grant' | 'browser_grant' | 'local_browser_grant'
    >('cloud_grant'),
    [targetId, setTargetId] = useState(''),
    [origins, setOrigins] = useState(''),
    [uploads, setUploads] = useState(false),
    [downloads, setDownloads] = useState(false),
    [credentials, setCredentials] = useState(false),
    [guide, setGuide] = useState(false);
  const endpoint = `/api/v1/admin/tenants/${organizationId}/environments`,
    request = useRef<AbortController | null>(null);
  function accept(value: AdminTenantEnvironments) {
    if (
      value.organizationId !== organizationId ||
      value.workspaceId !== workspaceId ||
      value.subjectId !== subjectId
    )
      throw Error('返回范围不匹配，已拒绝显示。');
    return value;
  }
  async function load() {
    request.current?.abort();
    const c = new AbortController();
    request.current = c;
    setBusy(true);
    setError('');
    try {
      const value = accept(
        await json<AdminTenantEnvironments>(
          await fetch(
            `${endpoint}?workspaceId=${workspaceId}&subjectId=${subjectId}`,
            { cache: 'no-store', signal: c.signal },
          ),
        ),
      );
      if (c.signal.aborted) return;
      setData(value);
    } catch (e) {
      if (!c.signal.aborted) {
        setData(null);
        setError(e instanceof Error ? e.message : '加载失败');
      }
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [endpoint, workspaceId, subjectId]);
  useEffect(() => {
    onDirty(dirty || !!reason);
  }, [dirty, reason, onDirty]);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  async function mutate(payload: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setData(
        accept(
          await json<AdminTenantEnvironments>(
            await fetch(endpoint, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                workspaceId,
                subjectId,
                reason,
                ...payload,
              }),
            }),
          ),
        ),
      );
      setDirty(false);
      setReason('');
      setTargetId('');
      setOrigins('');
      setUploads(false);
      setDownloads(false);
      setCredentials(false);
      setNotice(
        payload.action === 'revoke'
          ? '撤销已记录；停止/本地清理由执行器确认，不能当作已物理停止。'
          : '平台授权已保存；设备端确认、员工版本、运行审批仍需分别满足。',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存状态未知，请刷新核对。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <h3>环境与连接器</h3>
      <p>
        云端可独立使用，不要求安装
        Bridge。本地离线不会自动转云、上传文件或重放未知结果。
      </p>
      <button disabled={busy} onClick={() => void load()}>
        刷新环境状态
      </button>
      <button onClick={() => setGuide(!guide)}>设备下载与确认指引</button>
      {guide ? (
        <aside aria-label="设备确认指引">
          <p>
            请让所选使用者在自己的电脑登录租户前台 → 本地工作区 →
            生成配对码/选择工作区。平台管理员不会替他生成配对凭证。
          </p>
          <p>
            <a href="/api/v1/bridge/client/macos-arm64" download>
              下载 M 芯片 Bridge
            </a>{' '}
            ·{' '}
            <a href="/api/v1/bridge/client/macos-x64" download>
              下载 Intel Bridge
            </a>
          </p>
          <p>
            设备主人在 Bridge 菜单确认工作区、沙箱和独立浏览器；MCP
            本地凭证只在设备保存。这里不能开启宿主 Shell、读取个人 Chrome
            登录态或代选目录。
          </p>
        </aside>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <label>
        管理操作原因
        <input
          aria-label="环境修改原因"
          minLength={5}
          maxLength={500}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <nav>
        {(['environment', 'mcp', 'local-mcp'] as const).map((v) => (
          <button
            key={v}
            disabled={busy}
            aria-pressed={v === section}
            onClick={() => {
              if (
                !dirty ||
                window.confirm('切换将放弃未保存的环境修改，是否继续？')
              ) {
                setSection(v);
                setDirty(false);
              }
            }}
          >
            {
              {
                environment: '设备、沙箱与浏览器',
                mcp: '云端 MCP 配置',
                'local-mcp': '本地 MCP 配置',
              }[v]
            }
          </button>
        ))}
      </nav>
      {section === 'mcp' ? (
        <McpSettings
          workspaceId={workspaceId}
          management={{
            organizationId,
            subjectId,
            reason,
            onBusy: setBusy,
            onDirty: setDirty,
          }}
        />
      ) : section === 'local-mcp' ? (
        <LocalMcpSettings
          workspaceId={workspaceId}
          management={{
            organizationId,
            subjectId,
            reason,
            onBusy: setBusy,
            onDirty: setDirty,
          }}
        />
      ) : data ? (
        <>
          <p>
            检查时间：{new Date(data.observedAt).toLocaleString()}
            。设备本地开关仍须本人确认；服务端授权不等于设备已开启。
          </p>
          {data.devices.map((d) => (
            <article key={d.id}>
              <strong>{d.name}</strong> ·{' '}
              {d.status === 'online' ? '最近心跳在线' : '离线'}
              <p>
                设备主人：{d.ownerId}；工作区：
                {d.folderGrants.map((f) => f.label).join('、') || '未选择'}
                ；最后心跳：
                {d.lastSeenAt
                  ? new Date(d.lastSeenAt).toLocaleString()
                  : '未知'}
              </p>
            </article>
          ))}
          <details>
            <summary>全部能力前置条件（不是执行授权回执）</summary>
            {data.prerequisites.map((reasons) => (
              <article key={reasons[0]!.id}>
                <strong>{capabilityLabels[reasons[0]!.id].title}</strong>
                <ul>
                  {reasons.map((r, i) => (
                    <li key={`${r.reason}-${i}`}>
                      {capabilityStateLabels[r.state]} ·{' '}
                      {capabilityReasons[r.reason]}（处理人：
                      {r.responsibleRole === 'user'
                        ? '使用者/设备主人'
                        : r.responsibleRole === 'platform_admin'
                          ? '平台管理员'
                          : '平台管理员配置，使用者无需升管理员'}
                      ）
                    </li>
                  ))}
                </ul>
                {reasons.some((r) =>
                  [
                    'policy_missing',
                    'policy_denied',
                    'employee_policy',
                    'employee_missing',
                  ].includes(r.reason),
                ) ? (
                  <a
                    href={`/runtime-console?view=tenants&organizationId=${organizationId}&workspaceId=${workspaceId}`}
                  >
                    前往该租户的执行策略与 Rice 发布
                  </a>
                ) : null}
              </article>
            ))}
          </details>
          <details>
            <summary>单次任务审批状态（与环境授权分开）</summary>
            <p>
              平台环境授权目前没有到期时间，需显式撤销。单次任务审批有独立有效期；
              审批过期不等于设备离线，也不代表整项能力被禁用。
              使用者应回到对应任务查看审批卡，不能在这里补批、续期或重放操作。
            </p>
            {data.approvalDiagnostics.length ? (
              data.approvalDiagnostics.map((a) => (
                <p key={a.id}>
                  Run {a.runId.slice(0, 8)} ·{' '}
                  {
                    {
                      pending: '等待使用者审批',
                      approved: '已批准，尚未消费',
                      rejected: '使用者已拒绝',
                      revoked: '单次审批已撤销',
                      expired: '单次审批已过期',
                    }[a.state]
                  }
                  {' · '}有效期至 {new Date(a.expiresAt).toLocaleString()}
                </p>
              ))
            ) : (
              <p>当前未结束任务没有待消费的单次审批。</p>
            )}
            {data.approvalDiagnosticsTruncated ? (
              <p>仅显示最近 100 条，请到对应任务查看完整审批记录。</p>
            ) : null}
          </details>
          <h4>已有平台授权</h4>
          {data.grants.length ? (
            data.grants.map((g) => (
              <article key={g.id}>
                <strong>
                  {
                    {
                      cloud: '云端沙箱',
                      browser: '云端浏览器',
                      local_browser: '设备独立浏览器',
                    }[g.kind]
                  }
                </strong>{' '}
                · {g.enabled ? '有效' : '已撤销'} · v{g.version}
                <p>
                  授权使用者：{g.ownerId}
                  {g.deviceId ? ` · 设备：${g.deviceId}` : ''}
                </p>
                <details>
                  <summary>授权范围与隔离配置</summary>
                  <pre>{JSON.stringify(g.profile, null, 2)}</pre>
                </details>
                {g.cleanupRequested ? (
                  <p>
                    {g.cleanupConfirmed
                      ? '设备已确认清理'
                      : '等待设备清理确认，不代表已经停止'}
                  </p>
                ) : null}
                <button
                  disabled={busy || !g.enabled || reason.trim().length < 5}
                  onClick={() => {
                    if (
                      window.confirm(
                        '撤销此平台授权？在途任务的停止由执行器确认。',
                      )
                    )
                      void mutate({
                        action: 'revoke',
                        kind: g.kind,
                        grantId: g.id,
                        expectedVersion: g.version,
                      });
                  }}
                >
                  撤销授权
                </button>
              </article>
            ))
          ) : (
            <p>所选使用者尚无沙箱/浏览器平台授权。</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(
                kind === 'cloud_grant'
                  ? { action: kind, targetId }
                  : {
                      action: kind,
                      ...(kind === 'local_browser_grant'
                        ? { deviceId: targetId }
                        : { targetId }),
                      profile: {
                        version: 1,
                        origins: origins.split(/\s+/).filter(Boolean),
                        allowUploads: uploads,
                        allowDownloads: downloads,
                        allowHumanCredentials: credentials,
                      },
                    },
              );
            }}
          >
            <fieldset disabled={busy}>
              <legend>新增平台授权</legend>
              <label>
                授权能力
                <select
                  value={kind}
                  aria-label="授权能力"
                  onChange={(e) => {
                    setKind(e.target.value as typeof kind);
                    setTargetId('');
                    setDirty(true);
                  }}
                >
                  <option value="cloud_grant">云端受控沙箱（无网络）</option>
                  <option value="browser_grant">云端浏览器</option>
                  <option value="local_browser_grant">设备独立浏览器</option>
                </select>
              </label>
              <label>
                执行目标
                <select
                  aria-label="授权执行目标"
                  required
                  value={targetId}
                  onChange={(e) => {
                    setTargetId(e.target.value);
                    setDirty(true);
                  }}
                >
                  <option value="">请选择已注册目标</option>
                  {kind === 'local_browser_grant'
                    ? data.devices.map((d) => (
                        <option value={d.id} key={d.id}>
                          {d.name} · {d.status === 'online' ? '在线' : '离线'}
                        </option>
                      ))
                    : data.targets
                        .filter(
                          (t) =>
                            t.state !== 'revoked' &&
                            t.capabilities.includes(
                              kind === 'browser_grant'
                                ? 'browser.navigate'
                                : 'process.execute',
                            ),
                        )
                        .map((t) => (
                          <option value={t.id} key={t.id}>
                            {t.label} · {t.state}
                          </option>
                        ))}
                </select>
              </label>
              {kind !== 'cloud_grant' ? (
                <>
                  <label>
                    允许的网站 Origin（每行一个 HTTPS 站点）
                    <textarea
                      aria-label="允许的网站"
                      required
                      value={origins}
                      onChange={(e) => {
                        setOrigins(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  {(
                    [
                      ['允许上传', uploads, setUploads],
                      ['允许下载', downloads, setDownloads],
                      [
                        '允许人工输入凭证（不继承个人登录态）',
                        credentials,
                        setCredentials,
                      ],
                    ] as const
                  ).map(([label, value, set]) => (
                    <label key={label}>
                      <input
                        type="checkbox"
                        checked={value}
                        onChange={(e) => {
                          set(e.target.checked);
                          setDirty(true);
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </>
              ) : (
                <p>
                  固定 gVisor 隔离镜像、无网络、最多 1
                  个并行进程；不开放任意镜像或宿主执行。
                </p>
              )}
              {!data.prerequisites.find(
                (rs) =>
                  rs[0]?.id ===
                  (kind === 'cloud_grant'
                    ? 'cloud_command'
                    : kind === 'browser_grant'
                      ? 'cloud_browser'
                      : 'local_browser'),
              )?.[0]?.releaseEnabled ? (
                <p>
                  此部署尚未开放所选执行能力，请平台管理员检查服务端发布配置；此页不会自动开启部署开关。
                </p>
              ) : null}
              <button
                disabled={
                  !targetId ||
                  reason.trim().length < 5 ||
                  !data.prerequisites.find(
                    (rs) =>
                      rs[0]?.id ===
                      (kind === 'cloud_grant'
                        ? 'cloud_command'
                        : kind === 'browser_grant'
                          ? 'cloud_browser'
                          : 'local_browser'),
                  )?.[0]?.releaseEnabled
                }
              >
                保存平台授权
              </button>
            </fieldset>
          </form>
        </>
      ) : null}
    </div>
  );
}
