'use client';

import { useEffect, useRef, useState } from 'react';
import {
  RuntimeLocalCommandResultSchema,
  type RuntimeActionApprovalSnapshot,
  type RuntimeLocalCommand,
  type RuntimeOperationSnapshot,
} from '@allrice/contracts';
import styles from './local-command-panel.module.css';

interface Operation {
  snapshot: RuntimeOperationSnapshot;
  command: RuntimeLocalCommand['arguments'];
  approval: RuntimeActionApprovalSnapshot | null;
  output: { sequence: number; stream: 'stdout' | 'stderr'; content: string }[];
  evidence: { summary: string; output?: unknown } | null;
}
const statusLabels: Record<string, string> = {
  planned: '正在准备',
  waiting_user: '等待操作授权',
  ready: '等待 Bridge',
  dispatched: '已派发，尚未确认执行',
  running: '正在本地执行',
  cancel_requested: '正在停止，尚未确认',
  canceled: '已确认停止',
  succeeded: '命令执行成功',
  failed: '命令未成功',
  unknown: '执行结果待核实',
  partial: '部分完成',
};

export function LocalCommandPanel({
  runId,
  workspaceId,
  tenantHeaders,
  runActive,
}: {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
}) {
  const [operations, setOperations] = useState<Operation[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const responses = useRef(new Map<string, unknown>());
  const api = `/api/v1/runtime/local-commands?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`;
  const headerKey = JSON.stringify(tenantHeaders);
  const active =
    runActive ||
    operations.some(
      (o) =>
        !['succeeded', 'failed', 'canceled', 'partial'].includes(
          o.snapshot.status,
        ),
    );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(api, {
          cache: 'no-store',
          headers: JSON.parse(headerKey) as Record<string, string>,
          signal: abort.signal,
        });
        if (response.status === 404) return; // Feature is off, not an empty execution result.
        if (!response.ok) throw Error('本地命令状态读取失败，请刷新重试');
        const data = (await response.json()) as { operations: Operation[] };
        if (!abort.signal.aborted) {
          setOperations(data.operations);
          setError('');
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      }
      if (active && !abort.signal.aborted)
        timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, headerKey, active, revision]);

  async function act(
    op: Operation,
    decision: 'approved' | 'rejected' | 'cancel',
  ) {
    const request = op.approval?.request;
    if (busy || (decision !== 'cancel' && !request)) return;
    const id = op.snapshot.binding.attempt.operationId;
    setBusy(id);
    setError('');
    try {
      let body: unknown;
      if (request && decision !== 'cancel') {
        const key = `${request.approvalId}:${decision}`;
        if (!responses.current.has(key))
          responses.current.set(key, {
            contractVersion: 1,
            direction: 'response',
            kind: 'action_approval',
            requestId: request.requestId,
            version: request.version,
            requestDigest: request.requestDigest,
            task: request.task,
            responseId: crypto.randomUUID(),
            respondedBy: request.respondentId,
            respondedAt: new Date().toISOString(),
            approvalId: request.approvalId,
            decision,
          });
        body = responses.current.get(key);
      }
      const result = await fetch(
        decision === 'cancel'
          ? api
          : `/api/v1/runtime/approvals/${request!.approvalId}`,
        {
          method: 'POST',
          headers: {
            ...tenantHeaders,
            'x-allrice-workspace-id': workspaceId,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      if (!result.ok)
        throw Error(
          '操作未确认：授权可能已过期或已在其他页面处理，请刷新状态后重试。',
        );
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setBusy(null);
    }
  }
  if (!operations.length && !error) return null;
  return (
    <section className={styles.root} aria-label="本地命令审批与执行">
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            重试
          </button>
        </p>
      )}
      {operations.map((op) => {
        const id = op.snapshot.binding.attempt.operationId,
          request = op.approval?.request;
        const pending =
          request &&
          !op.approval?.response &&
          !op.approval?.revokedAt &&
          Date.parse(request.expiresAt) > Date.now() &&
          op.snapshot.status === 'waiting_user';
        const result = RuntimeLocalCommandResultSchema.safeParse(
          op.evidence?.output,
        );
        return (
          <article key={id} id={`operation-${id}`} data-status={op.snapshot.status}>
            <header>
              <strong>本地命令 · 操作授权</strong>
              <span>
                {statusLabels[op.snapshot.status] ?? op.snapshot.status}
              </span>
            </header>
            <p>在你的电脑的 Linux 隔离副本中执行；无网络，不会写回原工作区。</p>
            <pre aria-label="待执行命令">
              {op.command.executable}
              {op.command.args.map((arg) => ` ${JSON.stringify(arg)}`).join('')}
            </pre>
            <p>
              工作目录：<code>{op.command.path}</code> · 时限{' '}
              {op.command.limits.timeoutMs / 1000} 秒 · 内存{' '}
              {op.command.limits.memoryMiB} MiB · 最多 {op.command.limits.pids}{' '}
              个进程
            </p>
            <details>
              <summary>
                查看 {op.command.files.length} 个输入文件及精确版本
              </summary>
              <ul>
                {op.command.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code>
                    <small>{f.sha256}</small>
                  </li>
                ))}
              </ul>
              <small>工具链 {op.command.imageDigest}</small>
            </details>
            {pending && (
              <div className={styles.actions}>
                <button
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void act(op, 'approved')}
                >
                  批准这一次执行
                </button>
                <button
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void act(op, 'rejected')}
                >
                  拒绝
                </button>
                <small>此授权仅适用于上面的命令、参数、文件版本和环境。</small>
              </div>
            )}
            {op.approval?.response && (
              <p>
                你的决定：
                {op.approval.response.decision === 'approved'
                  ? '已批准这一次执行（不等于已完成）'
                  : '已拒绝'}
              </p>
            )}
            {!pending &&
              ['running', 'dispatched', 'ready', 'waiting_user'].includes(
                op.snapshot.status,
              ) && (
                <button
                  disabled={busy !== null}
                  type="button"
                  onClick={() => void act(op, 'cancel')}
                >
                  停止本轮本地命令
                </button>
              )}
            {op.evidence && <p>{op.evidence.summary}</p>}
            {(op.output.length > 0 || result.success) && (
              <details open={op.snapshot.status === 'running'}>
                <summary>
                  stdout / stderr
                  {result.success
                    ? ` · 退出码 ${result.data.exitCode}${result.data.truncated ? ' · 输出已截断' : ''}`
                    : ''}
                </summary>
                {result.success ? (
                  <>
                    <pre aria-label="stdout">{result.data.stdout}</pre>
                    <pre aria-label="stderr" className={styles.stderr}>
                      {result.data.stderr}
                    </pre>
                  </>
                ) : (
                  <pre>
                    {op.output.map((chunk) => (
                      <span
                        key={chunk.sequence}
                        className={
                          chunk.stream === 'stderr' ? styles.stderr : undefined
                        }
                      >
                        {chunk.content}
                      </span>
                    ))}
                  </pre>
                )}
              </details>
            )}
            {op.snapshot.status === 'unknown' && (
              <p role="status">
                尚未取得可信完成回执，不会自动重跑；请恢复 Bridge 连接后核实。
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
