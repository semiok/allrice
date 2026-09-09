'use client';
import { useEffect, useRef, useState } from 'react';
import type { LocalMcpOperationView } from '@allrice/database';
import styles from './local-command-panel.module.css';
const labels: Record<string, string> = {
  planned: '准备中',
  waiting_user: '等待这一次操作授权',
  ready: '等待 Bridge',
  dispatched: '已派发，等待执行确认',
  running: '本地 MCP 执行中',
  cancel_requested: '已请求停止，等待确认',
  canceled: '已确认停止',
  succeeded: '已返回并停止进程',
  failed: '未成功',
  unknown: '结果待核实，禁止自动重试',
  partial: '部分完成',
};
export function LocalMcpPanel({
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
  const [operations, setOperations] = useState<LocalMcpOperationView[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const responses = useRef(new Map<string, unknown>()),
    api = `/api/v1/runtime/local-mcp?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`,
    headerKey = JSON.stringify(tenantHeaders);
  const active =
    runActive ||
    operations.some(
      (o) =>
        !['succeeded', 'failed', 'canceled', 'partial', 'unknown'].includes(
          o.snapshot.status,
        ),
    );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(api, {
          cache: 'no-store',
          headers: JSON.parse(headerKey),
          signal: abort.signal,
        });
        if (response.status === 404) return;
        if (!response.ok) throw Error('本地 MCP 状态读取失败');
        const body = await response.json();
        if (!abort.signal.aborted) {
          setOperations(body.operations);
          setError('');
        }
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : '读取失败');
      }
      if (active && !abort.signal.aborted)
        timer = setTimeout(() => void load(), 1500);
    }
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, headerKey, active, revision]);
  async function act(
    op: LocalMcpOperationView,
    decision: 'approved' | 'rejected' | 'cancel',
  ) {
    if (busy) return;
    const request = op.approval?.request;
    if (decision !== 'cancel' && !request) return;
    setBusy(true);
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
      const response = await fetch(
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
      if (!response.ok)
        throw Error('操作未确认，可能已过期或在其他窗口处理，请刷新核对');
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败');
    } finally {
      setBusy(false);
    }
  }
  if (!operations.length && !error) return null;
  return (
    <section className={styles.root} aria-label="本地 MCP 审批与执行">
      {error && (
        <p role="alert">
          {error}{' '}
          <button onClick={() => setRevision((n) => n + 1)}>刷新</button>
        </p>
      )}
      {operations.map((op) => {
        const id = op.snapshot.binding.attempt.operationId,
          request = op.approval?.request,
          args = op.payload.arguments,
          pending =
            request &&
            !op.approval?.response &&
            !op.approval?.revokedAt &&
            Date.parse(request.expiresAt) > Date.now() &&
            op.snapshot.status === 'waiting_user';
        return (
          <article
            key={id}
            id={`operation-${id}`}
            data-status={op.snapshot.status}
          >
            <header>
              <strong>
                {op.payload.capability === 'local.mcp.discover'
                  ? '发现本地 MCP 工具'
                  : '调用本地 MCP 工具'}
              </strong>
              <span>{labels[op.snapshot.status] ?? op.snapshot.status}</span>
            </header>
            <p>
              执行设备：{op.deviceName} · 独立 Linux 沙箱 · 无网络 · 最长{' '}
              {args.limits.timeoutMs / 1000} 秒
            </p>
            <p>
              来源：{args.source.name}@{args.source.version} ·{' '}
              <code>
                {args.path}/{args.source.entrypoint}
              </code>
            </p>
            {op.payload.capability === 'local.mcp.call' && (
              <>
                <strong>{op.payload.arguments.tool.name}</strong>
                <pre aria-label="本次工具参数">
                  {JSON.stringify(op.payload.arguments.toolArguments, null, 2)}
                </pre>
              </>
            )}
            <details>
              <summary>
                输入文件与绑定版本（{args.source.files.length} 个）
              </summary>
              <pre>
                {JSON.stringify(
                  {
                    connectionId: args.connectionId,
                    connectionRevision: args.connectionRevision,
                    deviceId: args.deviceId,
                    source: args.source,
                    credentialReference: args.credential,
                    imageDigest: args.imageDigest,
                    limits: args.limits,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            <p>
              执行副本不会改写原目录；输出会回传 SaaS /
              模型。注册和发现不等于调用授权，批准仅限这一次。
            </p>
            {pending && (
              <div className={styles.actions}>
                <button
                  disabled={busy}
                  onClick={() => void act(op, 'approved')}
                >
                  批准这一次
                  {op.payload.capability === 'local.mcp.discover'
                    ? '启动发现'
                    : '调用'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void act(op, 'rejected')}
                >
                  拒绝
                </button>
              </div>
            )}
            {op.approval?.response && (
              <p>
                你的决定：
                {op.approval.response.decision === 'approved'
                  ? '已批准这一次（不代表成功）'
                  : '已拒绝'}
              </p>
            )}
            {!pending &&
              ['running', 'dispatched', 'ready'].includes(
                op.snapshot.status,
              ) && (
                <button disabled={busy} onClick={() => void act(op, 'cancel')}>
                  停止本轮任务
                </button>
              )}
            {op.evidence !== null && (
              <details>
                <summary>执行结果与停止证据</summary>
                <pre>{JSON.stringify(op.evidence, null, 2)}</pre>
              </details>
            )}
            {op.snapshot.status === 'unknown' && (
              <p role="status">
                此结果不能确定；不会重新发送工具调用。请核对执行设备和服务记录。
              </p>
            )}
            {op.payload.capability === 'local.mcp.discover' &&
              op.snapshot.status === 'succeeded' && (
                <p>
                  请到 MCP 设置刷新、审核并授权工具；下一条新任务才能采用。
                  <a href="/workspace/mcp">管理 MCP 连接</a>
                </p>
              )}
          </article>
        );
      })}
    </section>
  );
}
