'use client';
import { useEffect, useState } from 'react';
import type {
  ActivityCounts,
  OrganizationActivityRuns,
} from '@allrice/contracts';
import { TenantValidation } from './tenant-validation';
import { DshDialog } from '../chatflow/dsh-upstream/Dialog';
import { useActivityPages } from './organization-activity-data';
import styles from './tenant-administration.module.css';
const labels: Record<keyof ActivityCounts, string> = {
  running: '进行中',
  waiting: '等待处理',
  queued: '排队中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};
const duration = (ms: number) =>
  `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;

export function CompanyWorkList({
  organizationId,
  userId,
  name,
  automatic,
  scopeQuery,
  requested,
}: {
  organizationId: string;
  userId: string | null;
  name: string;
  automatic: boolean;
  scopeQuery: string;
  requested: { status: string; measure: string };
}) {
  const [status, setStatus] = useState('all'),
    [measure, setMeasure] = useState('activity'),
    [selected, setSelected] = useState<
      OrganizationActivityRuns['runs'][number] | null
    >(null);
  const page = useActivityPages<OrganizationActivityRuns>(
    `/api/v1/admin/activity?view=companyRuns&organizationId=${organizationId}${userId ? `&userId=${userId}` : ''}&status=${status}&measure=${measure}&${scopeQuery}`,
    'runs',
    'before',
  );
  useEffect(() => {
    setStatus(requested.status);
    setMeasure(requested.measure);
    setSelected(null);
  }, [requested]);
  useEffect(() => setSelected(null), [scopeQuery]);
  useEffect(() => {
    if (!automatic) return;
    const timer = setInterval(() => {
      if (!document.hidden) void page.load();
    }, 15000);
    return () => clearInterval(timer);
  }, [automatic, page.load]);
  return (
    <section className={styles.editor} aria-label="员工工作列表">
      <h3>{name} 的工作</h3>
      <div className={styles.selectors}>
        <label>
          工作状态
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setMeasure(
                e.target.value === 'all'
                  ? 'activity'
                  : ['succeeded', 'failed', 'canceled'].includes(e.target.value)
                    ? 'completed'
                    : 'current',
              );
              setSelected(null);
            }}
          >
            <option value="all">全部状态</option>
            {Object.entries(labels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button disabled={page.loading} onClick={() => void page.load()}>
          刷新工作列表
        </button>
      </div>
      {page.error && <p role="alert">{page.error}</p>}
      <div className={styles.table}>
        <table>
          <thead>
            <tr>
              <th>工作</th>
              <th>员工 / AI 员工</th>
              <th>进展</th>
              <th>耗时</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {page.data?.runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.title}</strong>
                  <small>
                    {new Date(r.createdAt).toLocaleString()}
                    {r.sessionArchived ? ' · 会话已归档' : ''}
                  </small>
                </td>
                <td>
                  <strong>{r.ownerName}</strong>
                  <small>{r.employeeName}</small>
                </td>
                <td>
                  {labels[r.status]}
                  <small>{r.stage}</small>
                </td>
                <td>
                  {r.timing ? (
                    <>
                      <span>工作 {duration(r.timing.activeMs)}</span>
                      <small>等待 {duration(r.timing.waitingMs)}</small>
                    </>
                  ) : (
                    '历史任务未记录时钟'
                  )}
                </td>
                <td>
                  <button
                    aria-haspopup="dialog"
                    aria-expanded={selected?.id === r.id}
                    onClick={() => setSelected(r)}
                  >
                    查看工作与成果
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!page.data && page.loading && <p role="status">正在读取工作…</p>}
      {page.data && !page.data.runs.length && <p>还没有匹配的工作。</p>}
      {page.data?.nextCursor && (
        <button disabled={page.loading} onClick={() => void page.load(true)}>
          更早的工作
        </button>
      )}
      {selected && (
        <DshDialog
          ariaLabel="工作与成果"
          title={selected.title}
          eyebrow={`${selected.ownerName} · ${selected.employeeName}`}
          className={`${styles.panel} ${styles.workDialog}`}
          bodyClassName={styles.workDialogBody}
          onClose={() => setSelected(null)}
        >
          <TenantValidation
            key={selected.id}
            organizationId={organizationId}
            workspaceId={selected.workspaceId}
            subjectId={selected.ownerId}
            initialRunId={selected.id}
            onDirty={() => undefined}
            onBusy={() => undefined}
          />
        </DshDialog>
      )}
    </section>
  );
}
