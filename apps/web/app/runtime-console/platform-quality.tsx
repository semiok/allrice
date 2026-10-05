'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  QualityCheckSchema,
  type QualityCheck,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/quality';
const labels = {
  queued: '排队中',
  running: '检查中',
  succeeded: '检查完成',
  failed: '未完成',
  canceled: '已停止',
};
const verdicts = {
  passed: '质检通过',
  assertion_failed: '断言未通过',
  blocked: '环境或权限受阻',
  execution_failed: '执行未完成',
  canceled: '已停止',
  unknown: '结果未知',
};
type Submission = {
  requestId: string;
  caseId: 'project.static.v1';
  variant: 'defect' | 'correct';
};
const active = (q: QualityCheck) => ['queued', 'running'].includes(q.status);
const label = (q: QualityCheck) =>
  q.status === 'succeeded' && q.report
    ? verdicts[q.report.verdict]
    : labels[q.status];
export function PlatformQuality() {
  const [checks, setChecks] = useState<QualityCheck[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<Submission | null>(null),
    [writing, setWriting] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(false),
    requestSequence = useRef(0);
  const read = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw Error('quality_unavailable');
    const next = QualityCheckSchema.array()
      .max(20)
      .parse(await response.json());
    if (mounted.current && sequence === requestSequence.current)
      setChecks(next);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void read().catch(() => {
      if (mounted.current) setError('质检记录暂不可读，请刷新核对。');
    });
    return () => {
      mounted.current = false;
      requestSequence.current++;
    };
  }, [read]);
  const hasActive = checks.some(active);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      void read().catch(() => {
        if (mounted.current) setError('状态暂未更新，原检查仍保留。');
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [hasActive, read]);
  async function refresh() {
    try {
      await read();
      if (mounted.current) setError('');
    } catch {
      if (mounted.current) setError('质检记录暂不可读，请稍后核对。');
    }
  }
  async function submit(variant: Submission['variant']) {
    if (writing) return;
    const request = pending ?? {
      requestId: crypto.randomUUID(),
      caseId: 'project.static.v1' as const,
      variant,
    };
    setPending(request);
    setWriting(true);
    setError('');
    try {
      const previous = (await read()).find(
        (q) => q.requestId === request.requestId,
      );
      if (previous) {
        setSelected(previous.id);
        setPending(null);
        return;
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw Error('quality_submit_unconfirmed');
      const check = QualityCheckSchema.parse(await response.json());
      if (mounted.current) {
        setSelected(check.id);
        setPending(null);
      }
      await read();
    } catch {
      const previous = await read()
        .then((rows) => rows.find((q) => q.requestId === request.requestId))
        .catch(() => undefined);
      if (mounted.current) {
        if (previous) {
          setSelected(previous.id);
          setPending(null);
        } else setError('提交结果尚未确认。请核对记录；重试仍使用原请求编号。');
      }
    } finally {
      if (mounted.current) setWriting(false);
    }
  }
  const detail = checks.find((q) => q.id === selected);
  async function stop() {
    if (!detail || writing) return;
    setWriting(true);
    try {
      const response = await fetch(`${endpoint}/${detail.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw Error('stop_unconfirmed');
      await read();
    } catch {
      setError('停止结果尚未确认，请刷新核对。');
      await read().catch(() => undefined);
    } finally {
      if (mounted.current) setWriting(false);
    }
  }
  return (
    <section className={css.card} aria-label="固定场景质检">
      <h2>固定场景质检</h2>
      <p className={css.meta}>
        在平台私有测试区构建小项目，点击“计算”后检查结果是否为
        2。错误样例用于证明能发现问题；修正样例使用同一断言。本次不调用模型。
      </p>
      <div className={css.controls}>
        <AdminButton
          disabled={writing || hasActive || !!pending}
          onClick={() => void submit('defect')}
        >
          检查错误样例
        </AdminButton>
        <AdminButton
          disabled={writing || hasActive || !!pending}
          onClick={() => void submit('correct')}
        >
          检查修正样例
        </AdminButton>
        {pending && (
          <AdminButton
            disabled={writing}
            onClick={() => void submit(pending.variant)}
          >
            核对并重试原检查
          </AdminButton>
        )}
        <AdminButton onClick={() => void refresh()}>刷新质检记录</AdminButton>
      </div>
      {error && <p role="alert">{error}</p>}
      {checks.length === 0 && !error && (
        <p className={css.meta}>尚无质检记录。</p>
      )}
      {checks.map((q) => (
        <div className={css.record} key={q.id}>
          <div>
            <strong>{q.variant === 'defect' ? '错误样例' : '修正样例'}</strong>
            <p className={css.meta}>
              {new Date(q.createdAt).toLocaleString('zh-CN')} · Run{' '}
              {q.runId.slice(0, 8)}
            </p>
          </div>
          <AdminStatus
            tone={
              q.accepted
                ? 'success'
                : q.report?.verdict === 'assertion_failed'
                  ? 'warning'
                  : 'muted'
            }
          >
            {label(q)}
          </AdminStatus>
          <AdminButton onClick={() => setSelected(q.id)}>
            查看质检详情
          </AdminButton>
        </div>
      ))}
      {detail && (
        <article className={css.card} aria-label="质检详情">
          <div className={css.controls}>
            <h3>{label(detail)}</h3>
            {active(detail) && (
              <AdminButton disabled={writing} onClick={() => void stop()}>
                停止检查
              </AdminButton>
            )}
          </div>
          <p className={css.meta}>
            版本 {detail.releaseSha.slice(0, 10)} · 员工版本{' '}
            {detail.employeeVersionId.slice(0, 8)} · 样例 project.static.v1
          </p>
          <p className={css.meta}>
            范围：本次固定静态项目及页面。持续服务、其他项目和完整能力矩阵仍需各自验收。
          </p>
          {!detail.report && (
            <p className={css.meta}>
              {active(detail)
                ? '等待实际构建与断言证据。'
                : '检查已结束，但证据不完整，不能判定通过。'}
            </p>
          )}
          {detail.report && (
            <>
              <p>
                构建{' '}
                {detail.report.build
                  ? `退出码 ${detail.report.build.exitCode ?? '未知'} · ${detail.report.build.location === 'local' ? '我的电脑' : '云端'}`
                  : '尚无完整证据'}{' '}
                · 资源回收{' '}
                {detail.report.cleanup === 'confirmed' ? '已确认' : '待确认'}
              </p>
              {detail.report.errorCode && (
                <p className={css.meta}>原因 {detail.report.errorCode}</p>
              )}
              <ol>
                {detail.report.browser?.report.steps.map((step) => (
                  <li key={step.index}>
                    {step.type === 'click' ? '点击计算按钮' : '检查计算结果'}：
                    {step.status === 'passed' || step.status === 'completed'
                      ? '通过'
                      : step.status === 'failed'
                        ? '未通过'
                        : '未知'}
                    {step.expected !== null &&
                      `；期望 ${step.expected}；实际 ${step.actual ?? '未知'}`}
                  </li>
                ))}
              </ol>
              <div className={css.controls}>
                {detail.report.artifacts.map((a) => (
                  <a
                    key={a.versionId}
                    href={`${endpoint}/${detail.id}/artifacts/${a.artifactId}`}
                  >
                    {a.fileName}
                  </a>
                ))}
              </div>
              <details>
                <summary>版本核对信息</summary>
                <p className={css.meta}>
                  样例 {detail.fixtureDigest}
                  <br />
                  断言 {detail.assertionDigest}
                  <br />
                  质检器 {detail.runnerDigest}
                  <br />
                  检查组合 {detail.fingerprint}
                </p>
              </details>
            </>
          )}
        </article>
      )}
    </section>
  );
}
