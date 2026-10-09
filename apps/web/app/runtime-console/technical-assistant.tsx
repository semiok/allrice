'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TechnicalAssistantResponseSchema,
  TechnicalIssueDetailSchema,
  type TechnicalDiagnostics,
  type TechnicalEvidence,
  type TechnicalIssue,
  type TechnicalRecord,
} from '@allrice/database/technical-contracts';
import { UuidSchema } from '@allrice/contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
import { TechnicalTasks } from './technical-tasks';
import { PlatformQuality } from './platform-quality';
import { PlatformRepositoryRepair } from './platform-repository-repair';
import { PlatformRepositoryCredentialPanel } from './platform-repository-credential';
import { PlatformMaintenance } from './platform-maintenance';

const endpoint = '/api/v1/admin/technical-assistant';
const statusLabels = {
  open: '待处理',
  investigating: '排查中',
  resolved: '已解决',
  ignored: '已忽略',
};
const categoryLabels = {
  unknown: '原因待确认',
  configuration: '配置问题',
  upstream: '外部服务',
  capacity: '资源等待',
  quality: '结果质量',
  defect: '产品缺陷',
};
const severityLabels = { low: '低', medium: '中', high: '高' };
type Detail = ReturnType<typeof TechnicalIssueDetailSchema.parse>;
type ResponseData = ReturnType<typeof TechnicalAssistantResponseSchema.parse>;
const sourceNames = { run: 'Run', operation: '工具操作', feedback: '员工反馈' };
function time(value: string | null) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '尚无采样';
}
function bytes(value: number) {
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function Evidence({ value }: { value: TechnicalEvidence }) {
  const label =
    value.freshness === 'fresh'
      ? '已采集'
      : value.freshness === 'stale'
        ? '样本过期'
        : '未知';
  const reason =
    value.unavailableReason === 'not_configured'
      ? '未配置探测目标'
      : value.unavailableReason === 'no_sample'
        ? '尚无 Worker 样本'
        : value.unavailableReason
          ? '本次采集未成功'
          : null;
  return (
    <p className={css.meta}>
      <AdminStatus tone={value.freshness === 'fresh' ? 'success' : 'warning'}>
        {label}
      </AdminStatus>{' '}
      {reason ?? time(value.sampledAt)}
    </p>
  );
}
function Health({
  title,
  sample,
}: {
  title: string;
  sample: TechnicalDiagnostics['web'];
}) {
  return (
    <article className={css.card}>
      <h3>{title}</h3>
      <strong>
        {!sample.value
          ? '状态未知'
          : sample.value.status === 'ready'
            ? '服务就绪'
            : sample.value.status === 'not_ready'
              ? '服务未就绪'
              : '无法连接'}
      </strong>
      <p className={css.meta}>
        发布版本 {sample.value?.releaseSha?.slice(0, 10) ?? '未知'}
      </p>
      <Evidence value={sample.evidence} />
    </article>
  );
}
function Records({
  title,
  sample,
  onCapture,
  busy,
}: {
  title: string;
  sample: TechnicalDiagnostics['runs'];
  onCapture: (record: TechnicalRecord) => void;
  busy: boolean;
}) {
  return (
    <details className={css.card}>
      <summary>
        {title} · {sample.value ? `${sample.value.length} 条` : '未知'}
      </summary>
      <Evidence value={sample.evidence} />
      <p className={css.meta}>
        近 24 小时最近 20 条。仅列状态和引用，不复制对话、命令或日志原文。
      </p>
      {sample.value?.length === 0 && (
        <p className={css.meta}>该时间窗内没有记录。</p>
      )}
      {sample.value?.map((item) => (
        <div className={css.record} key={`${item.kind}:${item.id}`}>
          <div>
            <strong>
              {sourceNames[item.kind]} {item.id.slice(0, 8)}
            </strong>
            <p className={css.meta}>
              {item.status}
              {item.errorCode && ` · ${item.errorCode}`}
              {item.action && ` · ${item.action}`}
              {item.category && ` · ${item.category}`} · {time(item.observedAt)}
            </p>
          </div>
          <AdminButton disabled={busy} onClick={() => onCapture(item)}>
            记录问题
          </AdminButton>
        </div>
      ))}
    </details>
  );
}

export function TechnicalAssistant() {
  const [data, setData] = useState<ResponseData | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [initialSource, setInitialSource] = useState<{
    kind: TechnicalRecord['kind'];
    id: string;
  } | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [sourceKind, setSourceKind] = useState<TechnicalRecord['kind']>('run');
  const [linkIssueId, setLinkIssueId] = useState('');
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoading(true);
    try {
      const response = await fetch(endpoint, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw Error('technical_data_unavailable');
      const next = TechnicalAssistantResponseSchema.parse(
        await response.json(),
      );
      if (!controller.signal.aborted) {
        setData(next);
        setError('');
      }
    } catch {
      if (!controller.signal.aborted) {
        setData(null);
        setError('未能读取技术诊断，请稍后刷新。原问题记录会保留。');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const kind = query.get('sourceKind'),
      id = query.get('sourceId');
    if (
      ['run', 'operation', 'feedback'].includes(kind ?? '') &&
      UuidSchema.safeParse(id).success
    ) {
      setInitialSource({ kind: kind as TechnicalRecord['kind'], id: id! });
      setSourceKind(kind as TechnicalRecord['kind']);
      setSourceId(id!);
    }
    void load();
    return () => loadAbort.current?.abort();
  }, [load]);
  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${endpoint}/issues/${selected}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('technical_detail_unavailable');
        const next = TechnicalIssueDetailSchema.parse(await response.json());
        if (!controller.signal.aborted) setDetail(next);
      } catch {
        if (!controller.signal.aborted)
          setError('问题详情暂不可用，请刷新后重试。');
      }
    })();
    return () => controller.abort();
  }, [selected, detailRevision]);

  async function capture(input: { kind: TechnicalRecord['kind']; id: string }) {
    if (writing) return;
    if (!UuidSchema.safeParse(input.id).success) {
      setError('请输入完整的记录 ID。');
      return;
    }
    setWriting(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: input.kind,
          id: input.id,
          ...(linkIssueId ? { issueId: linkIssueId } : {}),
        }),
      });
      if (!response.ok) throw Error('issue_capture_unconfirmed');
      const next: unknown = await response.json();
      if (!next || typeof next !== 'object' || !('detail' in next))
        throw Error('invalid_issue_response');
      const result = TechnicalIssueDetailSchema.parse(next.detail);
      setSelected(result.issue.id);
      // Selection's GET reads the canonical stored result, also after duplicate capture.
      setDetail(result);
      await load();
    } catch {
      setError(
        '操作结果尚未确认，请刷新问题列表后核对；不存在的记录无法保存。',
      );
    } finally {
      setWriting(false);
    }
  }
  async function update(input: {
    status: TechnicalIssue['status'];
    category: TechnicalIssue['category'];
    severity: TechnicalIssue['severity'];
  }) {
    if (!detail || writing) return;
    setWriting(true);
    setError('');
    try {
      const response = await fetch(`${endpoint}/issues/${detail.issue.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, ifVersion: detail.issue.version }),
      });
      if (!response.ok && response.status !== 409)
        throw Error('issue_update_unconfirmed');
      const result = await response.json();
      setDetail(TechnicalIssueDetailSchema.parse(result.detail));
      await load();
      if (response.status === 409)
        setError('问题已被更新，已读取最新记录，请核对后再保存。');
    } catch {
      setError('保存结果尚未确认，请重新打开问题核对状态。');
    } finally {
      setWriting(false);
    }
  }
  const diagnostics = data?.diagnostics;
  const busy = writing || loading;
  return (
    <section className={css.root} aria-label="技术助手">
      <header className={css.heading}>
        <div>
          <h1>技术助手</h1>
          <p>
            查看诊断、巡检与问题报告。自主修复、独立审查和发布已延期；历史结果仍可查看。
          </p>
        </div>
        <AdminButton icon="refresh" disabled={busy} onClick={() => void load()}>
          {loading ? '采集中…' : '刷新诊断'}
        </AdminButton>
      </header>
      <TechnicalTasks issueId={selected} />
      <PlatformMaintenance />
      <PlatformQuality />
      <PlatformRepositoryCredentialPanel />
      <PlatformRepositoryRepair readOnly />
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      {initialSource && (
        <p className={css.meta}>
          来自 {sourceNames[initialSource.kind]} {initialSource.id.slice(0, 8)}
          。核对下方引用后记录问题。
        </p>
      )}
      {diagnostics && (
        <>
          <p className={css.meta}>
            环境 {diagnostics.environment} · 最近读取{' '}
            {time(diagnostics.capturedAt)}
          </p>
          <div className={css.cards}>
            <Health title="Web" sample={diagnostics.web} />
            <Health title="Worker" sample={diagnostics.worker} />
            <article className={css.card}>
              <h3>任务与资源等待</h3>
              <strong>
                {diagnostics.pressure.value
                  ? `${diagnostics.pressure.value.jobs.queued} 排队 · ${diagnostics.pressure.value.jobs.active} 执行`
                  : '状态未知'}
              </strong>
              {diagnostics.pressure.value && (
                <p className={css.meta}>
                  最长排队{' '}
                  {(
                    diagnostics.pressure.value.jobs.longestWaitMs / 1000
                  ).toFixed(0)}{' '}
                  秒 · 等待资源 {diagnostics.pressure.value.resources.waiting}{' '}
                  项 · 锁等待 {diagnostics.pressure.value.locks.length} 项
                </p>
              )}
              <Evidence value={diagnostics.pressure.evidence} />
            </article>
          </div>
          <details className={css.card}>
            <summary>Worker 与沙箱资源</summary>
            <Evidence value={diagnostics.inventory.evidence} />
            {diagnostics.inventory.value?.workers.map((worker) => (
              <div className={css.record} key={worker.workerId}>
                <div>
                  <strong>
                    {worker.hostname} ·{' '}
                    {worker.online ? '心跳有效' : '心跳过期'}
                  </strong>
                  <p className={css.meta}>
                    采样 {time(worker.observedAt)} · CPU 容量{' '}
                    {worker.capacity.cpus} 核 · Worker 内存{' '}
                    {bytes(worker.rssBytes)} · 可用内存{' '}
                    {bytes(worker.availableMemoryBytes)}
                  </p>
                  <p className={css.meta}>
                    {worker.sandbox
                      ? `沙箱 ${worker.sandbox.running}/${worker.sandbox.slots} 槽位 · 内存 ${bytes(worker.sandbox.availableBytes)} 可用`
                      : worker.sandboxStatus === 'disabled'
                        ? '未启用云端沙箱'
                        : '沙箱状态未知'}
                  </p>
                </div>
              </div>
            ))}
          </details>
          <Records
            title="Run 状态"
            sample={diagnostics.runs}
            onCapture={(record) => void capture(record)}
            busy={busy}
          />
          <Records
            title="工具操作"
            sample={diagnostics.operations}
            onCapture={(record) => void capture(record)}
            busy={busy}
          />
          <Records
            title="员工主动反馈"
            sample={diagnostics.feedback}
            onCapture={(record) => void capture(record)}
            busy={busy}
          />
        </>
      )}
      <div className={css.capture}>
        <h2>记录问题</h2>
        <p className={css.meta}>
          保存现有记录的引用。同一引用只记录一次；可将相关证据归入已有问题。
        </p>
        <div className={css.controls}>
          <select
            aria-label="问题来源"
            value={sourceKind}
            disabled={busy}
            onChange={(e) =>
              setSourceKind(e.target.value as TechnicalRecord['kind'])
            }
          >
            {Object.entries(sourceNames).map(([kind, label]) => (
              <option value={kind} key={kind}>
                {label}
              </option>
            ))}
          </select>
          <input
            aria-label="来源记录 ID"
            placeholder="完整 Run、操作或反馈 ID"
            value={sourceId}
            maxLength={36}
            disabled={busy}
            onChange={(e) => setSourceId(e.target.value)}
          />
          <select
            aria-label="归入问题"
            value={linkIssueId}
            disabled={busy}
            onChange={(e) => setLinkIssueId(e.target.value)}
          >
            <option value="">新建问题</option>
            {data?.issues.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <AdminButton
            variant="primary"
            disabled={busy || !sourceId}
            onClick={() => void capture({ kind: sourceKind, id: sourceId })}
          >
            保存引用
          </AdminButton>
        </div>
      </div>
      <div className={css.split}>
        <article className={css.card}>
          <h2>问题记录</h2>
          <p className={css.meta}>
            最近 100 个问题 · 次数按不同证据计数，刷新不增加次数。
          </p>
          {data?.issues.length === 0 && <p>暂无问题记录。</p>}
          {data?.issues.map((item) => (
            <button
              className={css.issue}
              key={item.id}
              aria-current={selected === item.id ? 'true' : undefined}
              disabled={writing}
              onClick={() => {
                setSelected(item.id);
                setDetailRevision((n) => n + 1);
              }}
            >
              <strong>{item.title}</strong>
              <span>
                {statusLabels[item.status]} · {categoryLabels[item.category]} ·{' '}
                {item.occurrenceCount} 条证据
              </span>
              <span>{time(item.updatedAt)}</span>
            </button>
          ))}
        </article>
        <article className={css.card}>
          {detail ? (
            <IssueDetail
              key={`${detail.issue.id}:${detail.issue.version}`}
              detail={detail}
              busy={writing}
              onSave={(input) => void update(input)}
            />
          ) : (
            <p className={css.meta}>
              {selected
                ? '正在读取问题详情…'
                : '选择一个问题，查看证据与处理状态。'}
            </p>
          )}
        </article>
      </div>
    </section>
  );
}
function IssueDetail({
  detail,
  busy,
  onSave,
}: {
  detail: Detail;
  busy: boolean;
  onSave: (input: {
    status: TechnicalIssue['status'];
    category: TechnicalIssue['category'];
    severity: TechnicalIssue['severity'];
  }) => void;
}) {
  const [status, setStatus] = useState(detail.issue.status);
  const [category, setCategory] = useState(detail.issue.category);
  const [severity, setSeverity] = useState(detail.issue.severity);
  return (
    <>
      <h2>{detail.issue.title}</h2>
      <p className={css.meta}>
        首次记录 {time(detail.issue.firstSeenAt)} · 最近记录{' '}
        {time(detail.issue.lastSeenAt)} · 环境 {detail.issue.environment}
      </p>
      <div className={css.controls}>
        <label>
          状态
          <select
            aria-label="技术问题状态"
            value={status}
            disabled={busy}
            onChange={(e) =>
              setStatus(e.target.value as TechnicalIssue['status'])
            }
          >
            {Object.entries(statusLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          原因
          <select
            aria-label="技术问题原因"
            value={category}
            disabled={busy}
            onChange={(e) =>
              setCategory(e.target.value as TechnicalIssue['category'])
            }
          >
            {Object.entries(categoryLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          严重程度
          <select
            aria-label="技术问题严重程度"
            value={severity}
            disabled={busy}
            onChange={(e) =>
              setSeverity(e.target.value as TechnicalIssue['severity'])
            }
          >
            {Object.entries(severityLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <AdminButton
          disabled={busy}
          onClick={() => onSave({ status, category, severity })}
        >
          保存处理状态
        </AdminButton>
      </div>
      <h3>证据引用</h3>
      <p className={css.meta}>
        最近 100 条引用。记录的是观察时状态，当前状态可通过诊断刷新核对。
      </p>
      {detail.records.map((item) => (
        <details key={`${item.kind}:${item.id}`} className={css.record}>
          <summary>
            {sourceNames[item.kind]} {item.id.slice(0, 8)} · {item.status}
          </summary>
          <dl>
            <dt>记录 ID</dt>
            <dd>{item.id}</dd>
            <dt>Run</dt>
            <dd>{item.runId}</dd>
            <dt>Job</dt>
            <dd>{item.jobId ?? '没有关联 Job'}</dd>
            <dt>公司 / 工作区</dt>
            <dd>
              {item.organizationId} / {item.workspaceId}
            </dd>
            <dt>观察时间</dt>
            <dd>{time(item.observedAt)}</dd>
            <dt>错误代码</dt>
            <dd>{item.errorCode ?? '没有记录'}</dd>
          </dl>
        </details>
      ))}
      <p className={css.meta}>
        关联 PR {detail.issue.linkedPr ?? '尚未关联'} · 修复发布版本{' '}
        {detail.issue.releaseSha?.slice(0, 10) ?? '尚未记录'}
      </p>
    </>
  );
}
