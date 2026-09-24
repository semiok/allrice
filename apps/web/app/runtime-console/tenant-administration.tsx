'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminTenant,
  AdminTenantMember,
  AdminTenantMembers,
} from '@allrice/contracts';
import styles from './tenant-administration.module.css';
import { TenantPolicyEditor } from './tenant-policy-editor';
import { TenantResourceEditor } from './tenant-resource-editor';
import { TenantEmployeeEditor } from './tenant-employee-editor';

const roles = { admin: '管理员', member: '成员', viewer: '只读成员' };
const errors: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '登录已失效，请重新登录。',
  AUTHORIZATION_DENIED: '需要平台管理员权限；租户管理员不能管理其他租户。',
  NOT_FOUND: '租户、工作区或成员已不存在或不可管理。',
  last_administrator:
    '不能停用或降级此范围内最后一位有效管理员。请先配置其他管理员。',
  member_conflict: '成员配置已被其他操作修改，请刷新后重新确认。',
  scope_mismatch: '成员授权范围已变化，请刷新后重新确认。',
  INVALID_REQUEST: '请检查修改内容，并填写至少 5 个字符的原因。',
};
async function json<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok)
    throw Error(
      errors[body.code] ?? '请求未完成，请刷新后核对；不会自动重发修改。',
    );
  return body as T;
}

export function TenantAdministration() {
  const [view, setView] = useState<
    | 'employees'
    | 'members'
    | 'policy'
    | 'environments'
    | 'quotas'
    | 'validation'
  >('employees');
  const [tenants, setTenants] = useState<AdminTenant[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [organizationId, setOrganizationId] = useState(''),
    [workspaceId, setWorkspaceId] = useState('');
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const selected = tenants.find((t) => t.id === organizationId);
  const request = useRef<AbortController | null>(null);
  const initialTarget = useRef(false);
  const load = useCallback(async (cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const data = await json<{
        tenants: AdminTenant[];
        nextCursor: string | null;
      }>(
        await fetch(
          `/api/v1/admin/tenants${cursor ? `?after=${cursor}` : ''}`,
          { cache: 'no-store', signal: controller.signal },
        ),
      );
      if (controller.signal.aborted) return;
      setTenants((old) =>
        cursor
          ? [
              ...old,
              ...data.tenants.filter((t) => !old.some((o) => o.id === t.id)),
            ]
          : data.tenants,
      );
      setNext(data.nextCursor);
      if (!initialTarget.current) {
        const params = new URLSearchParams(window.location.search),
          org = params.get('organizationId'),
          workspace = params.get('workspaceId');
        const tenant = data.tenants.find((t) => t.id === org);
        initialTarget.current = Boolean(tenant) || !data.nextCursor || !org;
        if (tenant) {
          setOrganizationId(tenant.id);
          if (tenant.workspaces.some((w) => w.id === workspace)) {
            setWorkspaceId(workspace!);
            const requestedView = params.get('tenantView');
            setView(
              requestedView === 'environments' ||
                requestedView === 'quotas' ||
                requestedView === 'validation' ||
                requestedView === 'members' ||
                requestedView === 'employees'
                ? requestedView
                : 'policy',
            );
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : '加载失败');
        setTenants([]);
        setOrganizationId('');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  const canSwitch = () =>
    !busy && (!dirty || window.confirm('切换将放弃尚未保存的修改，是否继续？'));
  return (
    <section className={styles.panel} aria-label="租户管理">
      <header>
        <h2>租户管理</h2>
        <p>派驻已有 AI 员工、管理真人成员，并查看工作区配置和用量。</p>
      </header>
      <div className={styles.selectors}>
        <label>
          租户
          <select
            aria-label="管理租户"
            value={organizationId}
            disabled={loading || busy}
            onChange={(e) => {
              if (canSwitch()) {
                setOrganizationId(e.target.value);
                setWorkspaceId(
                  tenants.find((t) => t.id === e.target.value)?.workspaces[0]
                    ?.id ?? '',
                );
                setDirty(false);
              }
            }}
          >
            <option value="">请选择租户</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.slug}
              </option>
            ))}
          </select>
        </label>
        <label>
          工作区
          <select
            aria-label="管理工作区"
            value={workspaceId}
            disabled={!selected || busy}
            onChange={(e) => {
              if (canSwitch()) {
                setWorkspaceId(e.target.value);
                if (!e.target.value) setView('members');
                setDirty(false);
              }
            }}
          >
            <option value="">全部范围（含组织级授权）</option>
            {selected?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <button disabled={loading || busy || dirty} onClick={() => void load()}>
          刷新租户
        </button>
        {next ? (
          <button disabled={loading || busy} onClick={() => void load(next)}>
            加载更多租户
          </button>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">正在读取租户…</p> : null}
      {selected ? (
        <>
          <p className={styles.target}>
            <strong>当前管理：{selected.name}</strong> /{' '}
            {selected.workspaces.find((w) => w.id === workspaceId)?.name ??
              '全部工作区'}
            <small>租户 ID：{selected.id} · 不切换或冒用成员身份</small>
          </p>
          <div className={styles.selectors}>
            <button
              disabled={busy || !workspaceId}
              aria-pressed={view === 'employees'}
              onClick={() => {
                if (canSwitch()) {
                  setView('employees');
                  setDirty(false);
                }
              }}
            >
              AI 员工团队
            </button>
            <button
              disabled={busy}
              aria-pressed={view === 'members'}
              onClick={() => {
                if (canSwitch()) {
                  setView('members');
                  setDirty(false);
                }
              }}
            >
              成员与角色
            </button>
            <button
              disabled={busy || !workspaceId}
              aria-pressed={view === 'policy'}
              onClick={() => {
                if (canSwitch()) {
                  setView('policy');
                  setDirty(false);
                }
              }}
            >
              执行策略
            </button>
            {(['environments', 'quotas', 'validation'] as const).map((v) => (
              <button
                key={v}
                disabled={busy || !workspaceId}
                aria-pressed={view === v}
                onClick={() => {
                  if (canSwitch()) {
                    setView(v);
                    setDirty(false);
                  }
                }}
              >
                {v === 'environments'
                  ? '环境与连接器'
                  : v === 'quotas'
                    ? '分层额度'
                    : '验收与交付'}
              </button>
            ))}
            {workspaceId ? (
              <a
                href={`/runtime-console?view=employees&workspaceId=${workspaceId}`}
                onClick={(event) => {
                  if (!canSwitch()) event.preventDefault();
                }}
              >
                员工生产后台 →
              </a>
            ) : (
              <span>选择具体工作区后配置策略与发布。</span>
            )}
          </div>
          {view === 'employees' && workspaceId ? (
            <TenantEmployeeEditor
              key={`${organizationId}/${workspaceId}`}
              organizationId={organizationId}
              workspaceId={workspaceId}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          ) : (view === 'environments' ||
              view === 'quotas' ||
              view === 'validation') &&
            workspaceId ? (
            <TenantResourceEditor
              key={`${organizationId}/${workspaceId}/${view}`}
              mode={view}
              organizationId={organizationId}
              workspaceId={workspaceId}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          ) : view === 'policy' && workspaceId ? (
            <TenantPolicyEditor
              key={`${organizationId}/${workspaceId}`}
              organizationId={organizationId}
              workspaceId={workspaceId}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          ) : (
            <Members
              key={`${organizationId}/${workspaceId}`}
              tenant={selected}
              workspaceId={workspaceId || null}
              onDirty={setDirty}
              onBusy={setBusy}
            />
          )}
        </>
      ) : !loading ? (
        <p>选择租户和工作区，查看在岗 AI 员工与真人成员。</p>
      ) : null}
    </section>
  );
}

function Members({
  tenant,
  workspaceId,
  onDirty,
  onBusy,
}: {
  tenant: AdminTenant;
  workspaceId: string | null;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
}) {
  const [data, setData] = useState<AdminTenantMembers | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<AdminTenantMember | null>(null),
    [role, setRole] = useState<AdminTenantMember['role']>('member');
  const [active, setActive] = useState(true),
    [reason, setReason] = useState('');
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const load = useCallback(
    async (cursor?: string) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setLoading(true);
      setError('');
      if (!cursor) setData(null);
      try {
        const query = new URLSearchParams();
        if (workspaceId) query.set('workspaceId', workspaceId);
        if (cursor) query.set('after', cursor);
        const result = await json<AdminTenantMembers>(
          await fetch(`/api/v1/admin/tenants/${tenant.id}?${query}`, {
            cache: 'no-store',
            signal: current.signal,
          }),
        );
        if (
          result.organizationId !== tenant.id ||
          result.workspaceId !== workspaceId
        )
          throw Error('返回的租户范围不匹配，请刷新。');
        if (!current.signal.aborted)
          setData((old) => ({
            ...result,
            members: cursor
              ? [...(old?.members ?? []), ...result.members]
              : result.members,
          }));
      } catch (e) {
        if (!current.signal.aborted) {
          setData(null);
          setError(e instanceof Error ? e.message : '读取失败');
        }
      } finally {
        if (!current.signal.aborted) setLoading(false);
      }
    },
    [tenant.id, workspaceId],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [load]);
  const close = () => {
    setEdit(null);
    setReason('');
    onDirty(false);
  };
  async function save() {
    if (!edit || busy) return;
    setBusy(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await json<{
        member: AdminTenantMember;
        changed: boolean;
      }>(
        await fetch(`/api/v1/admin/tenants/${tenant.id}/members/${edit.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspaceId: edit.workspaceId,
            expectedVersion: edit.version,
            role,
            active,
            reason,
          }),
        }),
      );
      if (!mounted.current) return;
      close();
      setNotice(
        result.changed
          ? '修改已保存并记录审计。后续请求将使用当前成员配置。'
          : '配置未变化。',
      );
      await load();
    } catch (e) {
      if (mounted.current) {
        close();
        setData(null);
        setError(
          e instanceof Error ? e.message : '保存结果未确认，请刷新核对。',
        );
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <div>
      <div className={styles.selectors}>
        <h3>成员与角色</h3>
        <button
          disabled={busy || loading || !!edit}
          onClick={() => void load()}
        >
          刷新成员
        </button>
      </div>
      <p>
        组织级授权覆盖其全部工作区；工作区授权只在对应工作区生效。停用某一授权不删除账号、文件或历史记录，其他有效授权仍可能允许访问。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? <p role="status">正在读取成员…</p> : null}
      {data ? (
        <div className={styles.table}>
          <table>
            <thead>
              <tr>
                <th>成员</th>
                <th>授权范围</th>
                <th>角色</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.displayName}</strong>
                    <small>{m.email}</small>
                  </td>
                  <td>
                    {m.workspaceId === null
                      ? '组织级 · 全部工作区'
                      : (tenant.workspaces.find((w) => w.id === m.workspaceId)
                          ?.name ?? m.workspaceId)}
                  </td>
                  <td>{roles[m.role]}</td>
                  <td>
                    {m.active ? '授权有效' : '授权已停用'}
                    {m.userStatus !== 'active'
                      ? ` / 账号${m.userStatus === 'disabled' ? '已停用' : '待激活'}`
                      : ''}
                  </td>
                  <td>
                    <button
                      disabled={busy || !!edit}
                      onClick={() => {
                        setEdit(m);
                        setRole(m.role);
                        setActive(m.active);
                        setReason('');
                        setNotice('');
                        onDirty(true);
                      }}
                    >
                      编辑 {m.displayName}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.members.length ? <p>此范围内没有成员。</p> : null}
        </div>
      ) : null}
      {data?.nextCursor ? (
        <button
          disabled={busy || loading || !!edit}
          onClick={() => void load(data.nextCursor!)}
        >
          加载更多成员
        </button>
      ) : null}
      {edit ? (
        <form
          className={styles.editor}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          aria-label="修改成员授权"
        >
          <h3>
            确认修改：{tenant.name} / {edit.displayName}
          </h3>
          <p>
            {edit.workspaceId === null
              ? '这是组织级授权，会影响该成员在整个租户内的访问。'
              : `仅修改工作区：${tenant.workspaces.find((w) => w.id === edit.workspaceId)?.name ?? edit.workspaceId}`}
          </p>
          <div className={styles.selectors}>
            <label>
              角色
              <select
                aria-label="成员角色"
                value={role}
                disabled={busy}
                onChange={(e) =>
                  setRole(e.target.value as AdminTenantMember['role'])
                }
              >
                {Object.entries(roles).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={active}
                disabled={busy}
                onChange={(e) => setActive(e.target.checked)}
              />
              授权有效
            </label>
          </div>
          <p>
            修改前：{roles[edit.role]} / {edit.active ? '有效' : '停用'} →
            修改后：{roles[role]} / {active ? '有效' : '停用'}
          </p>
          <label>
            修改原因
            <textarea
              aria-label="修改原因"
              required
              minLength={5}
              maxLength={500}
              disabled={busy}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p>
            不会授予平台管理员身份，不会开启工具、沙箱或本地目录权限。账号停用状态不由此操作恢复。
          </p>
          <div className={styles.selectors}>
            <button type="submit" disabled={busy || reason.trim().length < 5}>
              {busy ? '正在保存…' : '确认保存授权'}
            </button>
            <button type="button" disabled={busy} onClick={close}>
              取消修改
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
