'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RegressionEvidenceSchema,
  type RegressionEvidence,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/quality/evidence';
const groups = {
  native: '原生参数与模块回归',
  postgres: '数据库与交付回归',
  office: '固定云端 Office 回归',
};
const statuses = {
  passed: '通过',
  assertion_failed: '断言未通过',
  execution_failed: '执行未完成',
  unknown: '未知',
  skipped: '未执行',
  partially_verified: '部分验证',
};
const relations = {
  exact_source: '被测源码与当前发布一致',
  same_material: '源码材料一致，保留原被测 SHA',
  historical: '历史版本证据',
  unconfirmed: '当前版本尚不能核对',
};
export function PlatformQualityEvidence() {
  const [data, setData] = useState<RegressionEvidence | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const mounted = useRef(false),
    sequence = useRef(0),
    controller = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    const token = ++sequence.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        signal: request.signal,
      });
      if (!response.ok) throw Error('EVIDENCE_UNAVAILABLE');
      const next = RegressionEvidenceSchema.parse(await response.json());
      if (mounted.current && token === sequence.current) {
        setData(next);
        setError('');
      }
    } catch {
      if (mounted.current && token === sequence.current) {
        setData(null);
        setError('证据暂不可读，尚不能判定通过。');
      }
    } finally {
      if (mounted.current && token === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void read();
    return () => {
      mounted.current = false;
      sequence.current++;
      controller.current?.abort();
    };
  }, [read]);
  return (
    <section className={css.card} aria-label="版本化回归证据">
      <div className={css.controls}>
        <h3>版本化回归证据</h3>
        <AdminButton disabled={loading} onClick={() => void read()}>
          {loading ? '正在读取' : '刷新证据'}
        </AdminButton>
      </div>
      <p className={css.meta}>
        这些报告证明固定场景的测试结果。当前 Dev 页面验收、Bridge
        实机和其他项目仍需各自的交付记录。
      </p>
      {data?.deployedSha && (
        <p className={css.meta}>当前发布 {data.deployedSha.slice(0, 10)}</p>
      )}
      {error && <p role="status">{error}</p>}
      {data && data.state !== 'available' && (
        <p role="status">
          {data.state === 'not_configured'
            ? '尚未登记可核验的回归证据。'
            : '证据校验未通过，尚不能判定通过。'}
        </p>
      )}
      {data?.state === 'available' && !data.records.length && <p>尚无报告。</p>}
      {data?.records.map((record) => (
        <article
          key={record.id}
          className={css.card}
          aria-label={`${groups[record.group]} ${record.source.sha.slice(0, 10)}`}
        >
          <div className={css.controls}>
            <strong>{groups[record.group]}</strong>
            <AdminStatus
              tone={
                record.fullyVerified &&
                !record.source.dirty &&
                ['exact_source', 'same_material'].includes(record.relation)
                  ? 'success'
                  : record.runnerSucceeded
                    ? 'muted'
                    : 'warning'
              }
            >
              固定场景 {record.passedScenarioCount}/{record.scenarioCount} 通过
            </AdminStatus>
          </div>
          <p className={css.meta}>
            {relations[record.relation]} · 被测 {record.source.sha.slice(0, 10)}{' '}
            · {new Date(record.capturedAt).toLocaleString('zh-CN')}
            {record.source.dirty ? ' · 被测工作树含未提交改动' : ''}
          </p>
          {!record.fullyVerified && (
            <p>这份报告尚不能确认完整通过；请核对场景覆盖和原进程退出状态。</p>
          )}
          {record.executionExitStatus === 'not_recorded' && (
            <p>原进程退出状态未独立登记；这份历史报告仅能核对原始断言。</p>
          )}
          <p className={css.meta}>
            DSH Agent {record.versions.dshAgent ?? '未记录'} · DSH Web{' '}
            {record.versions.dshWeb ?? '未记录'} · Bridge 包{' '}
            {record.versions.actualBridgeVersion ?? '未记录'}
          </p>
          <p className={css.meta}>模型未调用；本报告未执行 Bridge 实机验收。</p>
          {record.scenarios.map((scenario) => (
            <details key={scenario.id}>
              <summary>
                {scenario.title} · {statuses[scenario.status]}
              </summary>
              <p>{scenario.boundary}</p>
              <p className={css.meta}>
                执行 {scenario.executed} 项 · 跳过 {scenario.skipped} 项
              </p>
              <p className={css.meta}>
                输入 {scenario.inputDigest}
                <br />
                断言 {scenario.assertionDigest}
              </p>
            </details>
          ))}
          <details>
            <summary>版本与原报告核对信息</summary>
            <p className={css.meta}>
              被测 SHA {record.source.sha}
              <br />
              源码材料 {record.source.treeDigest}
              <br />
              场景清单 {record.registryDigest}
              <br />
              原报告 {record.originalReportChecksum}
              <br />
              依赖锁 {record.versions.lockDigest ?? '未记录'}
              <br />
              Office 技能 {record.versions.officeSkillPin ?? '未记录'}
              <br />
              转换组件 {record.versions.officeConversionPackage ?? '未记录'}
            </p>
            <p>{record.scope}</p>
          </details>
        </article>
      ))}
    </section>
  );
}
