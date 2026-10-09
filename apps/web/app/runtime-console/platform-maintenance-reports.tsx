'use client';
import { useEffect, useRef, useState } from 'react';
import {
  MaintenanceReportPageSchema,
  MaintenanceReportAuthoritySchema,
  type MaintenanceReportPayload,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
type Page = ReturnType<typeof MaintenanceReportPageSchema.parse>;
const endpoint = '/api/v1/admin/technical-assistant/maintenance/reports';
const classifications = {
  healthy: '未发现异常',
  configuration_or_environment: '需要诊断',
  suspected_code: '疑似源码缺陷',
  synthetic_check: '合成检查',
};
const reasons = {
  no_failure: '当前检查未发现异常。',
  requires_diagnosis: '可能涉及配置、环境、资源或上游，需要核实根因。',
  registered_probe_needs_central_reproduction:
    '已登记检查发现异常，仍需中央核对准确源码版本并实际复现。',
  quality_failure_needs_root_cause:
    '固定正确样例未通过，需要区分产品缺陷和环境问题。',
  synthetic_defect_is_not_source_bug:
    '这是主动注入错误的检查样例，不代表 AllRice 源码存在同一缺陷。',
};
const findings: Record<
  MaintenanceReportPayload['facts']['findings'][number]['id'],
  string
> = {
  service_unavailable: '服务不可用',
  resource_wait: '资源等待过长',
  quality_failure: '固定场景未通过',
  secret_output: '输出脱敏检查未通过',
};
export function PlatformMaintenanceReports({
  deploymentId,
}: {
  deploymentId: string | null;
}) {
  const [data, setData] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0);
  const [authority, setAuthority] = useState<
    Record<string, ReturnType<typeof MaintenanceReportAuthoritySchema.parse>>
  >({});
  async function loadAuthority(id: string) {
    const current = epoch.current;
    try {
      const response = await fetch(endpoint + '/' + id + '/authority', {
        cache: 'no-store',
      });
      if (!response.ok) throw Error();
      const value = MaintenanceReportAuthoritySchema.parse(
        await response.json(),
      );
      if (current === epoch.current)
        setAuthority((old) => ({ ...old, [id]: value }));
    } catch {
      if (current === epoch.current)
        setError('中央复现依据暂时不可读，请刷新重试。');
    }
  }
  async function load(cursor?: string) {
    const current = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const query = new URLSearchParams();
      if (deploymentId) query.set('deploymentId', deploymentId);
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(endpoint + '?' + query.toString(), {
        cache: 'no-store',
      });
      if (!response.ok) throw Error();
      const value = MaintenanceReportPageSchema.parse(await response.json());
      if (epoch.current === current) setData(value);
    } catch {
      if (epoch.current === current) setError('报告暂时不可读，请刷新重试。');
    } finally {
      if (epoch.current === current) setBusy(false);
    }
  }
  useEffect(() => {
    setData(null);
    setAuthority({});
    void load();
    return () => {
      epoch.current++;
    };
  }, [deploymentId]);
  function download(report: Page['reports'][number]) {
    const url = URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                ...report,
                centralAuthority: authority[report.reportId] ?? null,
              },
              null,
              2,
            ),
          ],
          {
            type: 'application/json',
          },
        ),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `allrice-report-${report.reportId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section aria-label="公司维护报告">
      <h4>公司维护报告</h4>
      <p className={css.meta}>
        报告保留上报版本与检查依据。已认证来源不代表已确认源码根因，报告不会直接触发合并或部署。
      </p>
      <AdminButton disabled={busy} onClick={() => void load()}>
        刷新维护报告
      </AdminButton>
      {error && <p role="alert">{error}</p>}
      {data?.reports.length === 0 && (
        <p>暂无报告。独立部署连接后，检查结果会汇总到这里。</p>
      )}
      {data?.reports.map((report) => (
        <details
          key={report.reportId}
          onToggle={(e) => {
            if (e.currentTarget.open) void loadAuthority(report.reportId);
          }}
        >
          <summary>
            {report.companyName} · {report.deploymentName} ·{' '}
            <AdminStatus
              tone={
                report.assessment.classification === 'healthy'
                  ? 'success'
                  : 'muted'
              }
            >
              {classifications[report.assessment.classification]}
            </AdminStatus>{' '}
            · {new Date(report.receivedAt).toLocaleString()}
          </summary>
          <p>
            上报版本：<code>{report.payload.observedReleaseSha}</code> · 采样：
            {new Date(report.payload.sampledAt).toLocaleString()}
          </p>
          <p>{reasons[report.assessment.reason]}</p>
          {report.payload.facts.findings.map((f, i) => (
            <p key={i}>
              {findings[f.id]} · {f.occurrences} 项
              {f.errorCode && ' · ' + f.errorCode}
            </p>
          ))}
          {report.payload.facts.quality && (
            <p>
              固定场景：{report.payload.facts.quality.caseId} ·{' '}
              {report.payload.facts.quality.variant} ·{' '}
              {report.payload.facts.quality.verdict} · 清理{' '}
              {report.payload.facts.quality.cleanup}
            </p>
          )}
          {report.payload.facts.probe && (
            <p>
              复现规格：{report.payload.facts.probe.specId} · 未通过{' '}
              {report.payload.facts.probe.failedAssertions.length} 项
            </p>
          )}
          <p className={css.meta}>
            来源报告：{report.sourceReportId} · 内容摘要：{report.payloadDigest}
          </p>
          {authority[report.reportId]?.diagnoses.map((diagnosis) => (
            <div key={diagnosis.id} aria-label="中央复现结果">
              <p>
                {diagnosis.proof.verdict === 'confirmed_code'
                  ? '中央已复现源码缺陷'
                  : '中央当前版本未复现该缺陷'}{' '}
                · 目标版本：<code>{diagnosis.targetSha}</code>
              </p>
              <p className={css.meta}>
                已完成 {diagnosis.proof.probeResults.length} 项登记探测，
                {diagnosis.proof.failedAssertions.length}{' '}
                项未通过。源码与运行产物映射已核对；完整编译及修复前后回归仍需修复任务验证。
              </p>
              <p className={css.meta}>复现依据：{diagnosis.proofDigest}</p>
            </div>
          ))}
          <AdminButton onClick={() => download(report)}>
            下载问题报告
          </AdminButton>{' '}
          <AdminButton disabled>修复并提交 PR（待中央复现接入）</AdminButton>
        </details>
      ))}
      {data?.nextCursor && (
        <AdminButton
          disabled={busy}
          onClick={() => void load(data.nextCursor!)}
        >
          更早的报告
        </AdminButton>
      )}
    </section>
  );
}
