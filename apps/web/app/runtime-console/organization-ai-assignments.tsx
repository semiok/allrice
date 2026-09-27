'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedOrganization,
  OrganizationAiTarget,
  OrganizationAiCatalog,
} from '@allrice/contracts';
import styles from './tenant-administration.module.css';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  const body = await response.json();
  if (!response.ok)
    throw Error(
      body.code === 'employee_changed'
        ? '配发配置已更新，请刷新后重试。'
        : body.code === 'employee_not_published'
          ? 'AI 员工版本已更新或已停用，请刷新。'
          : body.code === 'NOT_FOUND'
            ? '选择的员工或工作区已变化，请重新选择。'
            : body.code === 'AUTHORIZATION_DENIED'
              ? '需要平台管理员账号。'
              : '配置未保存，请刷新核对后重试。',
    );
  return body;
}

export function OrganizationAiAssignments({
  organization,
  target = { type: 'all' },
  defaults = false,
  title,
  onClose,
  onBusy,
}: {
  organization: ManagedOrganization;
  target?: OrganizationAiTarget;
  defaults?: boolean;
  title?: string;
  onClose?: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(
    organization.workspaces.find(
      (w) => w.id === organization.defaultWorkspaceId,
    )?.id ??
      organization.workspaces[0]?.id ??
      '',
  );
  const [data, setData] = useState<OrganizationAiCatalog | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const abort = useRef<AbortController | null>(null),
    targetKey = JSON.stringify(target);
  const endpoint = `/api/v1/admin/organizations/${organization.id}/ai-employees`;
  const load = useCallback(async () => {
    abort.current?.abort();
    const current = new AbortController();
    abort.current = current;
    setLoading(true);
    setError('');
    try {
      const result = await request<OrganizationAiCatalog>(
        `${endpoint}?${new URLSearchParams({ workspaceId, target: targetKey })}`,
        { signal: current.signal },
      );
      if (!current.signal.aborted) setData(result);
    } catch (e) {
      if (!current.signal.aborted)
        setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, [endpoint, workspaceId, targetKey]);
  useEffect(() => {
    setData(null);
    void load();
    return () => abort.current?.abort();
  }, [load]);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  async function change(
    employee: OrganizationAiCatalog['employees'][number],
    action: 'include' | 'exclude' | 'inherit' | 'default',
    defaultEnabled?: boolean,
  ) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{
        targetCount: number;
        changedCount: number;
        cancellationRequestedCount: number;
      }>(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          employeeId: employee.employeeId,
          revisionId: employee.revisionId,
          expectedVersion: employee.deployment?.version ?? null,
          action,
          target: JSON.parse(targetKey),
          ...(defaultEnabled === undefined ? {} : { defaultEnabled }),
        }),
      });
      setNotice(
        (action === 'default'
          ? `公司默认配发已${defaultEnabled ? '开启' : '关闭'}，个人增删保持不变。`
          : `已更新 ${result.changedCount} 名员工的 AI 配发设置（本次选择 ${result.targetCount} 人）。`) +
          (result.cancellationRequestedCount
            ? `已请求停止 ${result.cancellationRequestedCount} 项相关工作，历史记录保留。`
            : ''),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={styles.editor}
      aria-label={defaults ? '公司默认 AI 员工' : '员工 AI 配发'}
    >
      <div className={styles.selectors}>
        <h3>{title ?? (defaults ? '公司默认 AI 员工' : '配置 AI 员工')}</h3>
        <button disabled={busy || loading} onClick={() => void load()}>
          刷新 AI 员工
        </button>
        {onClose && (
          <button disabled={busy} onClick={onClose}>
            完成
          </button>
        )}
      </div>
      <p>
        {defaults
          ? '默认配发适用于现有和后续新增员工，个人明确添加或移除的设置会保留。'
          : `本次选择 ${data?.targetCount ?? '…'} 人。添加、移除或恢复跟随公司默认；不会改变其他员工。`}
      </p>
      {organization.workspaces.length > 1 && (
        <label>
          历史工作区
          <select
            value={workspaceId}
            disabled={busy}
            onChange={(e) => setWorkspaceId(e.target.value)}
          >
            {organization.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">正在读取 AI 员工…</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>AI 员工</th>
              <th>配发情况</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.employees.map((e) => (
              <tr key={e.employeeId}>
                <td>
                  <strong>{e.name}</strong>
                  <small>{e.role}</small>
                </td>
                <td>
                  {e.targetAssignedCount} / {data.targetCount} 人当前可用
                  <small>
                    {e.inheritedByDefault ? '公司默认配发' : '按个人配发'}
                    {e.targetExcludedCount
                      ? ` · ${e.targetExcludedCount} 人已明确移除`
                      : ''}
                  </small>
                </td>
                <td>
                  {defaults ? (
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`默认配发 ${e.name}`}
                        checked={e.inheritedByDefault}
                        disabled={
                          busy ||
                          loading ||
                          (!e.canAssign && !e.inheritedByDefault)
                        }
                        onChange={(event) =>
                          void change(e, 'default', event.target.checked)
                        }
                      />
                      默认配发
                    </label>
                  ) : (
                    <div className={styles.selectors}>
                      <button
                        disabled={
                          busy || loading || !e.canAssign || !data.targetCount
                        }
                        onClick={() => void change(e, 'include')}
                      >
                        添加
                      </button>
                      <button
                        disabled={busy || loading || !data.targetCount}
                        onClick={() => void change(e, 'exclude')}
                      >
                        移除
                      </button>
                      <button
                        disabled={busy || loading || !data.targetCount}
                        onClick={() => void change(e, 'inherit')}
                      >
                        跟随公司默认
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && !data.employees.length && (
        <p>暂无已发布 AI 员工。先在「AI 员工」中发布，再在这里配发。</p>
      )}
    </section>
  );
}
