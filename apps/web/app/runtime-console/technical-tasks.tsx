'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  TechnicalTaskSchema,
  TechnicalTaskDetailSchema,
  type TechnicalTask,
} from '@allrice/database/technical-contracts';
import { AdminButton, AdminStatus } from '../../components/admin/admin-ui';
import css from './technical-assistant.module.css';
const endpoint = '/api/v1/admin/technical-assistant/tasks';
const labels = {
  queued: '排队中',
  running: '诊断中',
  succeeded: '已完成',
  failed: '未完成',
  canceled: '已停止',
};
type Detail = ReturnType<typeof TechnicalTaskDetailSchema.parse>;
type Submission = {
  requestId: string;
  issueId: string | null;
  question: string;
};
const active = (task: TechnicalTask) =>
  task.status === 'queued' || task.status === 'running';

export function TechnicalTasks({ issueId }: { issueId: string | null }) {
  const [question, setQuestion] = useState(
    '请根据实际诊断，说明当前平台状态和需要核对的问题。',
  );
  const [tasks, setTasks] = useState<TechnicalTask[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Submission | null>(null);
  const mounted = useRef(true);
  const read = useCallback(async () => {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw Error('technical_tasks_unavailable');
    const next = TechnicalTaskSchema.array()
      .max(20)
      .parse(await response.json());
    if (mounted.current) setTasks(next);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void read().catch(() => {
      if (mounted.current) {
        setTasks([]);
        setError('诊断任务暂不可读，请刷新核对。');
      }
    });
    return () => {
      mounted.current = false;
    };
  }, [read]);
  const hasActive = tasks.some(active);
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(
      () =>
        void read().catch(() => {
          if (mounted.current) setError('任务状态暂不可读，原任务仍保留。');
        }),
      2000,
    );
    return () => clearInterval(timer);
  }, [hasActive, read]);
  const selectedStatus = tasks.find((t) => t.id === selected)?.status;
  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`${endpoint}/${selected}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('technical_task_unavailable');
        const next = TechnicalTaskDetailSchema.parse(await response.json());
        if (!controller.signal.aborted) setDetail(next);
      } catch {
        if (!controller.signal.aborted) {
          setDetail(null);
          setError('任务详情暂不可读，请重新打开核对。');
        }
      }
    }
    void load();
    const timer =
      selectedStatus === 'queued' || selectedStatus === 'running'
        ? setInterval(() => void load(), 2000)
        : null;
    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [selected, selectedStatus, detailRefresh]);
  async function refresh() {
    try {
      await read();
      if (mounted.current) {
        setError('');
        setDetailRefresh((revision) => revision + 1);
      }
    } catch {
      if (mounted.current) setError('任务列表暂不可读。');
    }
  }
  async function submit() {
    if (writing || !question.trim()) return;
    const request = pending ?? {
      requestId: crypto.randomUUID(),
      issueId,
      question: question.trim(),
    };
    setPending(request);
    setWriting(true);
    setError('');
    try {
      // A lost write acknowledgement is reconciled before an idempotent retry.
      const existing = (await read()).find(
        (t) => t.requestId === request.requestId,
      );
      if (existing) {
        setSelected(existing.id);
        setPending(null);
        return;
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw Error('technical_submit_unconfirmed');
      const next = TechnicalTaskDetailSchema.parse(await response.json());
      setSelected(next.task.id);
      setDetail(next);
      setPending(null);
      await read();
    } catch {
      try {
        const existing = (await read()).find(
          (t) => t.requestId === request.requestId,
        );
        if (existing) {
          setSelected(existing.id);
          setPending(null);
          return;
        }
      } catch {
        /* Preserve the original request ID for explicit retry. */
      }
      setError(
        '提交结果尚未确认。请核对任务列表；再次提交会使用同一个请求编号。',
      );
    } finally {
      if (mounted.current) setWriting(false);
    }
  }
  async function stop() {
    if (!detail || writing) return;
    setWriting(true);
    setError('');
    try {
      const response = await fetch(`${endpoint}/${detail.task.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw Error('stop_unconfirmed');
      setDetail(TechnicalTaskDetailSchema.parse(await response.json()));
      await read();
    } catch {
      setError('停止结果尚未确认，请刷新状态核对。');
      await read().catch(() => undefined);
    } finally {
      if (mounted.current) setWriting(false);
    }
  }
  return (
    <section className={css.card} aria-label="平台诊断任务">
      <h2>让技术助手排查</h2>
      <p className={css.meta}>
        使用平台模型与只读诊断。
        {issueId ? '已关联当前问题。' : '未关联具体问题。'}
      </p>
      <label>
        排查问题
        <textarea
          aria-label="排查问题"
          value={question}
          maxLength={2000}
          rows={3}
          disabled={writing || !!pending}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      <div className={css.controls}>
        <AdminButton
          icon="play"
          disabled={writing || !question.trim()}
          onClick={() => void submit()}
        >
          {writing ? '提交中…' : pending ? '核对并重试原请求' : '开始诊断'}
        </AdminButton>
        <AdminButton
          icon="refresh"
          disabled={writing}
          onClick={() => void refresh()}
        >
          刷新任务
        </AdminButton>
      </div>
      {error && (
        <p role="alert" className={css.error}>
          {error}
        </p>
      )}
      <div className={css.controls}>
        {tasks.map((t) => (
          <AdminButton
            key={t.id}
            disabled={writing}
            onClick={() => setSelected(t.id)}
          >
            {labels[t.status]} · {t.question.slice(0, 24)}
          </AdminButton>
        ))}
      </div>
      {detail && (
        <article aria-label="诊断任务详情">
          <h3>{detail.task.question}</h3>
          <AdminStatus>{labels[detail.task.status]}</AdminStatus>
          <p className={css.meta}>
            模型 {detail.task.model} · 配置版本 {detail.task.modelRevision} ·
            Run {detail.task.runId.slice(0, 8)}
          </p>
          {active(detail.task) && (
            <AdminButton disabled={writing} onClick={() => void stop()}>
              停止诊断
            </AdminButton>
          )}
          {detail.task.answer && (
            <p style={{ whiteSpace: 'pre-wrap' }}>{detail.task.answer}</p>
          )}
          {detail.task.errorCode && (
            <p role="alert">诊断未完成：{detail.task.errorCode}</p>
          )}
          <p className={css.meta}>
            Token：
            {detail.task.usage
              ? `${detail.task.usage.inputTokens + detail.task.usage.outputTokens}${detail.task.usageComplete ? '' : '（记录不完整）'}`
              : '未知'}{' '}
            · 实际费用：未知
          </p>
          {detail.receipts.map((r) => (
            <details key={r.receiptId}>
              <summary>
                诊断回执 {r.receiptId.slice(0, 8)} ·{' '}
                {new Date(r.observedAt).toLocaleString('zh-CN')}
              </summary>
              <p>
                环境 {r.diagnostics.environment} · Web{' '}
                {r.diagnostics.web.value?.status ?? '未知'} · Worker{' '}
                {r.diagnostics.worker.value?.status ?? '未知'}
              </p>
              <pre>{JSON.stringify(r, null, 2)}</pre>
            </details>
          ))}
        </article>
      )}
    </section>
  );
}
