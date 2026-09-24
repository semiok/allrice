'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminTenantEmployee,
  AdminTenantEmployees,
} from '@allrice/contracts';
import styles from './tenant-administration.module.css';

const errors: Record<string, string> = {
  AUTHENTICATION_REQUIRED: '登录已失效，请重新登录。',
  AUTHORIZATION_DENIED: '当前账号不能管理此租户。',
  NOT_FOUND: '租户、工作区或员工已不存在，请刷新。',
  employee_changed: '员工版本或派驻状态已变化，请刷新后重新选择。',
  employee_not_published: '该发布版本已变化或已停用，请刷新后选择可用版本。',
  employee_not_assigned: '员工已撤回，请刷新列表。',
  INVALID_REQUEST: '请检查所选员工和备注。',
};
async function read<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok)
    throw Error(errors[body.code] ?? '操作未完成，请刷新核对当前状态。');
  return body as T;
}
export function TenantEmployeeEditor({
  organizationId,
  workspaceId,
  onBusy,
  onDirty,
}: {
  organizationId: string;
  workspaceId: string;
  onBusy: (busy: boolean) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [data, setData] = useState<AdminTenantEmployees | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(''),
    [note, setNote] = useState('');
  const request = useRef<AbortController | null>(null),
    lifetime = useRef(0);
  const endpoint = `/api/v1/admin/tenants/${organizationId}/employees?workspaceId=${workspaceId}`;
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await read<AdminTenantEmployees>(
        await fetch(endpoint, { cache: 'no-store', signal: controller.signal }),
      );
      if (!controller.signal.aborted) setData(next);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '读取失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [endpoint]);
  useEffect(() => {
    lifetime.current++;
    void load();
    return () => {
      lifetime.current++;
      request.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    onDirty(!!note || !!selected);
  }, [note, selected, onDirty]);
  const active = data?.employees.filter((e) => e.deployment?.active) ?? [];
  const available =
    data?.employees.filter((e) => e.canAssign && !e.deployment?.active) ?? [];
  async function change(
    employee: AdminTenantEmployee,
    action: 'assign' | 'withdraw' | 'default',
  ) {
    if (busy) return;
    const own = lifetime.current;
    setBusy(true);
    onBusy(true);
    setError('');
    setNotice('');
    try {
      await read(
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId,
            employeeId: employee.employeeId,
            action,
            revisionId:
              action === 'assign'
                ? employee.revisionId
                : employee.deployment!.revisionId,
            expectedVersion: employee.deployment?.version ?? null,
            note,
          }),
        }),
      );
      if (own !== lifetime.current) return;
      setNote('');
      setSelected('');
      onDirty(false);
      setNotice(
        action === 'assign'
          ? '员工已派驻，当前普通成员可以开始使用。'
          : action === 'withdraw'
            ? '员工已撤回，历史会话与成果保留。'
            : '已设为工作区默认员工，当前成员下次新建时使用。',
      );
      await load();
    } catch (cause) {
      if (own === lifetime.current)
        setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      if (own === lifetime.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <section aria-label="在岗 AI 员工">
      <h3>在岗 AI 员工</h3>
      <p>
        派驻已发布员工，当前普通成员即可使用。更新员工能力请前往员工生产后台发布。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading && !data ? <p role="status">正在读取员工…</p> : null}
      <div className={styles.selectors}>
        <label>
          选择已发布员工
          <select
            aria-label="选择已发布员工"
            value={selected}
            disabled={busy || loading}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">请选择员工</option>
            {available.map((e) => (
              <option key={e.employeeId} value={e.employeeId}>
                {e.name} · {e.role} · 发布 v{e.revision}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!selected || busy || loading}
          onClick={() => {
            const employee = available.find((e) => e.employeeId === selected);
            if (employee) void change(employee, 'assign');
          }}
        >
          派驻员工
        </button>
        <button
          disabled={busy || loading}
          onClick={() => {
            setError('');
            void load();
          }}
        >
          刷新员工
        </button>
      </div>
      <label>
        备注（可选）
        <input
          aria-label="派驻备注（可选）"
          maxLength={500}
          disabled={busy}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="无需填写即可操作"
        />
      </label>
      {!loading && data && !active.length ? (
        <p>此工作区暂无在岗 AI 员工。选择已发布员工后即可派驻。</p>
      ) : null}
      {!loading && data && !available.length ? (
        <small>没有其他可派驻的已发布员工。</small>
      ) : null}
      {active.map((employee) => {
        const deployed = employee.deployment!;
        return (
          <article
            key={employee.employeeId}
            aria-label={`在岗员工 ${deployed.name}`}
          >
            <h4>
              {deployed.name}
              {deployed.isDefault ? ' · 默认员工' : ''}
            </h4>
            <p>
              {deployed.role} · 已派驻 v{deployed.revision} ·{' '}
              {deployed.memberCount} 位可执行成员
            </p>
            <p>{deployed.description}</p>
            <p>
              技能：
              {deployed.skills.length
                ? deployed.skills.map((s) => s.name).join('、')
                : '按员工已有工具处理任务'}
            </p>
            <details>
              <summary>
                查看已派驻版本的工具（{deployed.toolNames.length}）
              </summary>
              <p>{deployed.toolNames.join('、') || '无额外工具'}</p>
            </details>
            <div className={styles.selectors}>
              {!deployed.isDefault ? (
                <button
                  disabled={busy || loading}
                  onClick={() => void change(employee, 'default')}
                >
                  设为默认员工
                </button>
              ) : null}
              {employee.canAssign &&
              deployed.revisionId !== employee.revisionId ? (
                <button
                  disabled={busy || loading}
                  onClick={() => void change(employee, 'assign')}
                >
                  更新到发布 v{employee.revision}
                </button>
              ) : null}
              <button
                disabled={busy || loading}
                onClick={() => void change(employee, 'withdraw')}
              >
                撤回员工
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
