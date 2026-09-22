'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChangesetRunsResponseSchema,
  type ChangesetRunView,
  type WorkbenchArtifact,
} from '@allrice/contracts';
import { inputRetry } from '../../lib/chatflow/input-retry';
import styles from './local-command-panel.module.css';
const labels: Record<string, string> = {
  pending: '未执行',
  prepared: '待核实',
  applied: '已确认落盘',
  conflict: '冲突 · 未覆盖',
  canceled: '未执行 · 已停止',
  failed: '失败',
  unknown: '结果未知 · 不自动重做',
  waiting_user: '等待精确授权',
  ready: '等待兼容 Bridge',
  dispatched: '已派发',
  running: '执行中',
  succeeded: '已完成',
  partial: '部分完成',
  cancel_requested: '正在停止',
  queued: '排队中',
};
export function ChangesetPanel({
  artifact,
  sessionId,
  workspaceId,
  headers,
  disabled,
  onContinued,
}: {
  artifact: WorkbenchArtifact;
  sessionId: string;
  workspaceId: string;
  headers: Record<string, string>;
  disabled: boolean;
  onContinued?: (runId: string) => void;
}) {
  const proposalCopy = artifact.execution?.workCopy.kind === 'local_copy';
  const [records, setRecords] = useState<ChangesetRunView[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const responses = useRef(new Map<string, unknown>()),
    generation = useRef(0);
  const api = `/api/v1/sessions/${sessionId}/artifacts/${artifact.id}/executions?workspaceId=${workspaceId}`;
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const g = ++generation.current;
      try {
        const r = await fetch(api, { headers, cache: 'no-store', signal });
        if (r.status === 404) {
          if (!signal?.aborted && g === generation.current) setRecords(null);
          return;
        }
        if (!r.ok) throw Error('文件任务状态暂不可用');
        const parsed = ChangesetRunsResponseSchema.parse(await r.json());
        if (!signal?.aborted && g === generation.current)
          setRecords(parsed.executions);
      } catch {
        if (!signal?.aborted && g === generation.current) {
          setRecords(null);
          setError('文件状态读取失败，请刷新工作台。');
        }
      }
    },
    [api, headers],
  );
  useEffect(() => {
    if (proposalCopy) return;
    const a = new AbortController();
    void reload(a.signal);
    const t = setInterval(() => void reload(a.signal), 1500);
    return () => {
      generation.current++;
      a.abort();
      clearInterval(t);
    };
  }, [reload, proposalCopy]);
  async function requestExecution(restoreOf: string | null) {
    if (busy || disabled || proposalCopy) return;
    setBusy(true);
    setError('');
    const body = {
      text: restoreOf ? '请求恢复已确认落盘的文件' : '请求应用审查的文件变更',
      deliveryMode: 'follow_up',
      changesetAction: {
        artifactId: artifact.id,
        checksum: artifact.object.checksum,
        restoreOf,
      },
    };
    try {
      const { id: clientMessageId } = await inputRetry(
        `${workspaceId}/${sessionId}`,
        body,
      );
      const r = await fetch(
        `/api/v1/sessions/${sessionId}/messages?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, clientMessageId }),
        },
      );
      if (!r.ok)
        throw Error(
          '任务未确认：请检查版本是否变化、该请求是否已经提交，然后刷新记录。',
        );
      const data = await r.json();
      onContinued?.(data.run.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败');
    } finally {
      setBusy(false);
    }
  }
  async function act(
    item: ChangesetRunView,
    decision: 'approved' | 'rejected' | 'cancel',
  ) {
    if (busy || (disabled && decision !== 'cancel')) return;
    const request = item.approval?.request;
    if (decision !== 'cancel' && !request) return;
    setBusy(true);
    setError('');
    try {
      let body: unknown = { runId: item.runId };
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
      const r = await fetch(
        decision === 'cancel'
          ? api
          : `/api/v1/runtime/approvals/${request!.approvalId}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'x-allrice-workspace-id': workspaceId,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw Error('操作未确认：授权可能过期或已在另一个页面处理。');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  if (proposalCopy)
    return (
      <section className={styles.root} aria-label="子助手开发提案">
        <h4>子助手提案 · 未写入本地</h4>
        <p>
          此版本属于助手的独立候选副本，不能直接应用到原目录。请由主 Rice
          合成候选版，完成同版本测试和独立审查后，再单独申请落盘审批。
        </p>
      </section>
    );
  if (records === null && !error) return null;
  return (
    <section className={styles.root} aria-label="文件变更审批与执行">
      <h4>审查后应用／恢复</h4>
      <p>
        仅作用于上述设备、授权目录和文件版本。不运行代码；批准后逐文件校验并应用，不承诺跨文件原子性。操作期间请暂停其他编辑器或程序修改这些文件。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {records && !records.some((r) => !r.restoreOf) ? (
        <button
          type="button"
          disabled={busy || disabled || artifact.stale}
          onClick={() => void requestExecution(null)}
        >
          请求应用本版变更
        </button>
      ) : null}
      {records?.map((item) => {
        const pending =
          item.snapshot?.status === 'waiting_user' &&
          item.approval &&
          !item.approval.response &&
          !item.approval.revokedAt &&
          Date.parse(item.approval.request.expiresAt) > Date.now();
        const stopped = ['succeeded', 'failed', 'canceled'].includes(
          item.runState,
        );
        return (
          <article
            key={item.runId}
            id={
              item.snapshot
                ? `operation-${item.snapshot.binding.attempt.operationId}`
                : undefined
            }
          >
            <strong>
              {item.restoreOf ? '恢复任务' : '应用任务'} ·{' '}
              {labels[item.snapshot?.status ?? item.runState] ?? item.runState}
            </strong>
            {item.payload ? (
              <details>
                <summary>
                  本次将处理 {item.payload.arguments.files.length} 个文件 ·
                  精确授权范围
                </summary>
                <small>
                  工件 {item.payload.arguments.checksum}
                  。以下前后内容是本次实际动作，恢复任务使用反向变更。
                </small>
                <ul>
                  {item.payload.arguments.files.map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code>
                      <small>
                        {f.before?.checksum ?? '不存在'} →{' '}
                        {f.after?.checksum ?? '删除文件'}
                      </small>
                      <details>
                        <summary>审查 {f.path} 的本次前后内容</summary>
                        <strong>执行前</strong>
                        <pre>{f.before?.text ?? '文件不存在'}</pre>
                        <strong>执行后</strong>
                        <pre>{f.after?.text ?? '删除这个文件'}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {pending ? (
              <div className={styles.actions}>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'approved')}
                >
                  批准这一次文件操作
                </button>
                <button
                  type="button"
                  disabled={busy || disabled}
                  onClick={() => void act(item, 'rejected')}
                >
                  拒绝
                </button>
                <small>
                  仅批准已审查的精确版本；版本、目录或授权变化后须重新审查。
                </small>
              </div>
            ) : null}
            {!stopped ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(item, 'cancel')}
              >
                停止剩余文件
              </button>
            ) : null}
            {item.evidence.result ? (
              <ul aria-label="逐文件执行结果">
                {item.evidence.result.files.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> · {labels[f.status]}
                    {f.errorCode ? <small>{f.errorCode}</small> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>尚无设备落盘证据；不能据此推断文件已修改。</p>
            )}
            {stopped &&
            !item.restoreOf &&
            !records.some((r) => r.restoreOf === item.runId) &&
            item.evidence.result?.files.some((f) => f.status === 'applied') ? (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={() => void requestExecution(item.runId)}
              >
                请求恢复已确认落盘的文件
              </button>
            ) : null}
          </article>
        );
      })}
      <small>
        恢复仅反转有回执的文件，再检查现状
        SHA；用户后续修改不会按旧版本覆盖。结果未知的文件需人工核对，不包含在恢复动作中。
      </small>
    </section>
  );
}
