'use client';
import { useEffect, useRef, useState } from 'react';
import {
  MaintenanceReportAuthoritySchema,
  type MaintenanceDeployment,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
type Authority = ReturnType<typeof MaintenanceReportAuthoritySchema.parse>;
const endpoint = '/api/v1/admin/technical-assistant/maintenance';
const ciLabels = {
  not_observed: '尚未读取 CI',
  pending: 'CI 进行中',
  unknown: 'CI 尚无法确认',
  failed: 'CI 未通过',
  stale: '版本已变化，需复验',
  passed: '四项原始 CI 已通过',
};
const statuses: Record<string, string> = {
  queued: '等待修复',
  claimed: '准备修复',
  running: '正在修复',
  succeeded: '候选验证通过',
  failed: '修复未完成',
  canceled: '已停止',
};
export function MaintenanceReportActions({
  reportId,
  reportDigest,
  authority,
  deployment,
  ready = false,
  refresh,
}: {
  reportId: string;
  reportDigest: string;
  authority: Authority | undefined;
  deployment: MaintenanceDeployment | undefined;
  ready?: boolean;
  refresh: () => Promise<Authority | null | undefined>;
}) {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const diagnosis = authority?.diagnoses.find(
    (d) => d.proof.verdict === 'confirmed_code',
  );
  async function authorize() {
    if (
      busy ||
      pending ||
      !ready ||
      !diagnosis ||
      !deployment ||
      authority?.grants.length
    )
      return;
    const requestId = crypto.randomUUID();
    setPending(requestId);
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(
        `${endpoint}/reports/${reportId}/authority`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            requestId,
            reportId,
            expectedReportDigest: reportDigest,
            expectedDiagnosisDigest: diagnosis.proofDigest,
            expectedDeploymentRevision: deployment.revision,
          }),
        },
      );
      if (!response.ok) throw Error('unconfirmed');
      const result = MaintenanceReportAuthoritySchema.parse(
        await response.json(),
      );
      if (!result.grants.some((g) => g.requestId === requestId))
        throw Error('unconfirmed');
      await refresh();
      if (mounted.current) {
        setPending(null);
        setNotice('本次授权已建立，等待受限修复；公司默认处理方式保持不变。');
      }
    } catch {
      const result = await refresh();
      if (!mounted.current) return;
      if (result?.grants.some((g) => g.requestId === requestId)) {
        setPending(null);
        setNotice('已回读确认本次授权，不会重复创建任务。');
      } else
        setNotice('授权结果尚未确认。请刷新处理状态核对；不会自动重复提交。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function read() {
    if (busy) return;
    setBusy(true);
    const result = await refresh();
    if (mounted.current) {
      if (result) {
        setPending(null);
        setNotice('已刷新当前记录。');
      }
      setBusy(false);
    }
  }
  async function control(id: string, action: 'revoke' | 'inspect') {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${endpoint}/grants/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw Error('unconfirmed');
      MaintenanceReportAuthoritySchema.parse(await response.json());
      await refresh();
      if (mounted.current)
        setNotice(
          action === 'revoke'
            ? '本次授权已撤销，停止新的修复和写入。已发出的请求仍可只读核实。'
            : '已请求只读核实 PR 与 CI，请稍后刷新处理状态。',
        );
    } catch {
      await refresh();
      if (mounted.current)
        setNotice('操作结果尚未确认，请核对当前状态；不会自动重复操作。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label="报告处理">
      <AdminButton
        disabled={
          busy ||
          !!pending ||
          !ready ||
          !diagnosis ||
          !deployment ||
          !!authority?.grants.length ||
          deployment.policy.paused ||
          !!deployment.revokedAt
        }
        onClick={() => void authorize()}
      >
        仅本次修复并提交 PR
      </AdminButton>{' '}
      <AdminButton disabled={busy} onClick={() => void read()}>
        刷新处理状态
      </AdminButton>
      <p className={css.meta}>
        仅已登记且中央确证的命令输出脱敏缺陷可进入受限修复，其他问题保留报告。自动合并和部署关闭。
      </p>
      {!ready && (
        <p className={css.meta}>
          GitHub 提交账号授权或当前源码基线尚未就绪；报告可继续查看和下载。
        </p>
      )}
      {authority?.grants.map((g) => (
        <div key={g.id} aria-label="修复授权记录">
          <p>
            <AdminStatus
              tone={g.repairStatus === 'succeeded' ? 'success' : 'muted'}
            >
              {g.revokedAt
                ? '授权已撤销'
                : Date.parse(g.expiresAt) <= Date.now()
                  ? '授权已到期'
                  : g.repairStatus
                    ? (statuses[g.repairStatus] ?? g.repairStatus)
                    : '已授权，等待执行'}
            </AdminStatus>{' '}
            · {g.origin === 'manual' ? '仅本次授权' : '按公司设置授权'} · 到期{' '}
            {new Date(g.expiresAt).toLocaleString()}
          </p>
          {!g.canControl && (
            <p className={css.meta}>
              已关联同一缺陷的现有任务和
              PR，不重复修复；只保留本公司的来源记录。
            </p>
          )}
          {g.publication && (
            <p>
              {g.publication.url ? (
                <a href={g.publication.url} target="_blank" rel="noreferrer">
                  查看 PR #{g.publication.number}
                </a>
              ) : (
                'PR 提交结果尚未确认'
              )}{' '}
              · {ciLabels[g.publication.ci.state]} · 发起公司{' '}
              {g.publication.sourceCompanySlug}
            </p>
          )}
          {!g.revokedAt && Date.parse(g.expiresAt) > Date.now() && (
            <AdminButton
              disabled={busy}
              onClick={() => void control(g.id, 'revoke')}
            >
              撤销本次授权
            </AdminButton>
          )}{' '}
          {g.canControl && g.publicationId && (
            <AdminButton
              disabled={busy}
              onClick={() => void control(g.id, 'inspect')}
            >
              核实 PR 与 CI
            </AdminButton>
          )}
        </div>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
