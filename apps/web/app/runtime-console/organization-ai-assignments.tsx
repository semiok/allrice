'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ManagedOrganization,
  OrganizationAiTarget,
  OrganizationAiCatalog,
} from '@allrice/contracts';
import { AdminButton } from '../../components/admin/admin-ui';
import styles from './organization-administration.module.css';

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
  workspaceId: configuredWorkspaceId,
}: {
  organization: ManagedOrganization;
  target?: OrganizationAiTarget;
  defaults?: boolean;
  title?: string;
  onClose?: () => void;
  onBusy?: (busy: boolean) => void;
  workspaceId?: string;
}) {
  const [localWorkspaceId, setWorkspaceId] = useState(
    organization.workspaces.find(
      (w) => w.id === organization.defaultWorkspaceId,
    )?.id ??
      organization.workspaces[0]?.id ??
      '',
  );
  const workspaceId = configuredWorkspaceId ?? localWorkspaceId;
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
          ? defaultEnabled
            ? `已开启「${employee.name}」全员自动配发，现有员工和以后新增的员工都会自动获得；单独为某人添加或移除的设置不变。`
            : `已关闭「${employee.name}」全员自动配发，跟随公司设置获得的配发已撤回；单独为某人添加的仍保留。`
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
      className={styles.aiAssignments}
      aria-label={defaults ? '全员自动配发 AI 员工' : '员工 AI 配发'}
    >
      <div className={styles.sectionHeader}>
        <div className={styles.sectionTitle}>
          <h3>{defaults ? '全员自动配发' : 'AI 员工'}</h3>
          <span className={styles.meta}>
            {data
              ? `${data.employees.length} 个 AI 员工 · ${data.targetCount} 名员工`
              : '正在读取…'}
          </span>
        </div>
        <AdminButton
          variant="icon"
          icon="refresh"
          aria-label="刷新 AI 员工"
          disabled={busy || loading}
          onClick={() => void load()}
        />
      </div>
      <p className={styles.meta}>
        {defaults
          ? '开启后自动配发给现有和新增员工。个人单独添加或移除的设置保留。'
          : `${title ?? '本次配发'} · ${data?.targetCount ?? '…'} 人。操作即时保存，仅影响本次范围。`}
      </p>
      {configuredWorkspaceId === undefined &&
        organization.workspaces.length > 1 && (
          <label className={styles.workspaceSelector}>
            历史工作区
            <select
              aria-label="历史工作区"
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
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {busy && (
        <p className={styles.meta} role="status">
          正在保存配发…
        </p>
      )}
      {loading && (
        <p className={styles.meta} role="status">
          正在读取 AI 员工…
        </p>
      )}
      <table className={styles.aiTable}>
        <thead>
          <tr>
            <th>AI 员工</th>
            <th>配发情况</th>
            <th className={styles.alignEnd}>
              {defaults ? '自动配发 · 即时保存' : '操作'}
            </th>
          </tr>
        </thead>
        <tbody>
          {data?.employees.map((e) => (
            <tr key={e.employeeId}>
              <td>
                <span className={styles.aiName}>{e.name}</span>
                <small>{e.role}</small>
              </td>
              <td>
                {e.targetAssignedCount} / {data.targetCount} 人当前可用
                <small>
                  {e.inheritedByDefault
                    ? '已开启全员自动配发（含新员工）'
                    : '未开启自动配发，按个人配置使用'}
                  {e.targetExcludedCount
                    ? ` · ${e.targetExcludedCount} 人已明确移除`
                    : ''}
                </small>
              </td>
              <td>
                {defaults ? (
                  <label className={styles.autoAssign}>
                    <input
                      className={styles.toggle}
                      type="checkbox"
                      aria-label={`全员自动配发 ${e.name}（含新员工）`}
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
                    <span className={styles.meta}>
                      {e.inheritedByDefault
                        ? '已开启'
                        : e.canAssign
                          ? '未开启'
                          : '暂不可配发'}
                    </span>
                  </label>
                ) : (
                  <div className={styles.aiActions}>
                    <AdminButton
                      variant="quiet"
                      disabled={
                        busy || loading || !e.canAssign || !data.targetCount
                      }
                      onClick={() => void change(e, 'include')}
                    >
                      添加
                    </AdminButton>
                    <AdminButton
                      variant="quiet"
                      disabled={busy || loading || !data.targetCount}
                      onClick={() => void change(e, 'exclude')}
                    >
                      移除
                    </AdminButton>
                    <AdminButton
                      variant="quiet"
                      disabled={busy || loading || !data.targetCount}
                      onClick={() => void change(e, 'inherit')}
                    >
                      跟随公司默认
                    </AdminButton>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && !data.employees.length && (
        <p className={styles.empty}>
          暂无已发布 AI 员工。先在「AI 员工」中发布，再在这里配发。
        </p>
      )}
      {defaults && (
        <p className={styles.meta}>
          关闭会撤回跟随公司的配发，个人单独添加的保留。部分人员配发可在员工列表中设置。
        </p>
      )}
      {onClose && (
        <div className={styles.dialogFooter}>
          <AdminButton variant="primary" disabled={busy} onClick={onClose}>
            完成
          </AdminButton>
        </div>
      )}
    </section>
  );
}
