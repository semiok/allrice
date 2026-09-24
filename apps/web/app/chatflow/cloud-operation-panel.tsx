'use client';
import { useEffect, useRef, useState } from 'react';
import type { CloudOperationView } from '@allrice/database';
import styles from './cloud-operation-panel.module.css';

const labels: Record<string, string> = {
  planned: '正在准备',
  waiting_user: '等待本次授权',
  ready: '等待执行',
  dispatched: '已派发，尚未确认执行',
  running: '正在执行',
  cancel_requested: '停止意图已记录，结果待确认',
  unknown: '远端结果待核实',
  succeeded: '执行已返回成功',
  failed: '执行未成功',
  canceled: '已确认未执行或停止',
  partial: '部分完成',
};
export function cloudOperationDisplayStatus(
  op: CloudOperationView,
  now = Date.now(),
) {
  if (op.snapshot.status === 'waiting_user' && op.approval) {
    if (op.approval.revokedAt) return '授权已撤销';
    if (op.approval.response?.decision === 'rejected') return '已拒绝本次操作';
    if (Date.parse(op.approval.request.expiresAt) <= now)
      return '本次授权已过期';
    if (op.proposal.kind === 'mcp' && op.mcpAuthorization?.available !== true)
      return mcpAuthorizationLabel(op);
    if (op.approval.response?.decision === 'approved')
      return '已批准，等待派发';
  }
  return labels[op.snapshot.status] ?? op.snapshot.status;
}
type Decision = 'approved' | 'rejected' | 'cancel';
function mcpAuthorizationLabel(op: CloudOperationView) {
  switch (op.mcpAuthorization?.reason) {
    case 'connection_revoked':
      return '连接授权已撤销';
    case 'connection_or_tool_changed':
      return '连接或工具授权已变化';
    case 'employee_authorization_changed':
      return '员工授权已失效';
    default:
      return '当前授权暂时无法核实';
  }
}
export function CloudOperationCard({
  op,
  busy,
  onAct,
}: {
  op: CloudOperationView;
  busy: boolean;
  onAct: (op: CloudOperationView, decision: Decision) => void;
}) {
  const request = op.approval?.request,
    proposal = op.proposal;
  const mcpUnavailable =
    proposal.kind === 'mcp' && op.mcpAuthorization?.available !== true;
  const pending =
    op.enabled &&
    !mcpUnavailable &&
    request &&
    !op.approval?.response &&
    !op.approval?.revokedAt &&
    Date.parse(request.expiresAt) > Date.now() &&
    op.snapshot.status === 'waiting_user';
  const terminal = ['succeeded', 'failed', 'canceled', 'partial'].includes(
    op.snapshot.status,
  );
  return (
    <article
      id={`operation-${op.snapshot.binding.attempt.operationId}`}
      data-status={op.snapshot.status}
    >
      <header>
        <strong>
          {proposal.kind === 'cloud'
            ? '云端隔离计算 · 操作授权'
            : '第三方 MCP 工具 · 操作授权'}
        </strong>
        <span role="status">{cloudOperationDisplayStatus(op)}</span>
      </header>
      {!op.enabled && (
        <p className={styles.notice}>
          新执行已停用；保留已有记录与授权状态，仍可请求停止本轮。
        </p>
      )}
      {mcpUnavailable && (
        <p role="status" className={styles.notice}>
          {mcpAuthorizationLabel(op)}。不能再批准此操作；未派发的操作不会执行。
          已派发的操作不等于已经停止，请核实返回记录。历史结果仍保留。
          {!terminal && '仍可请求停止本轮。'}
        </p>
      )}
      {proposal.kind === 'cloud' ? (
        <>
          <p>
            在 SaaS 云端的隔离副本中运行 Node
            脚本，禁止联网；只读取下列明确授权的已上传文件，不操作你的电脑。
          </p>
          <details open={!!pending}>
            <summary>查看本次脚本</summary>
            <pre aria-label="云端待执行脚本">{proposal.script}</pre>
          </details>
          <details open={!!pending}>
            <summary>输入文件与精确版本（{proposal.inputs.length}）</summary>
            {proposal.inputs.length ? (
              <ul>
                {proposal.inputs.map((file) => (
                  <li key={file.objectId}>
                    <code>{file.path}</code>
                    <small>文件 ID：{file.objectId}</small>
                    <small>{file.checksum}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p>无输入文件。</p>
            )}
          </details>
          <p>
            交付文件：
            {proposal.outputs.length
              ? proposal.outputs
                  .map((o) => `${o.fileName} (${o.format})`)
                  .join('、')
              : '无'}
          </p>
          <small>
            时限 {proposal.limits.timeoutMs / 1000} 秒 · 内存{' '}
            {proposal.limits.memoryMiB} MiB · CPU {proposal.limits.cpuMillis}{' '}
            毫核 · 最多 {proposal.limits.pids} 个进程 · 输出{' '}
            {proposal.limits.outputBytes} 字节 · 成果{' '}
            {proposal.limits.artifactBytes} 字节
          </small>
        </>
      ) : (
        <>
          <p className={styles.notice}>
            批准后，会将下面列出的参数发送给此第三方服务；服务在 AllRice
            沙箱之外运行，可能读取或修改其账号内的数据。
          </p>
          <p>
            目标服务：<code>{proposal.endpoint}</code>
          </p>
          <p>
            工具：<code>{proposal.tool}</code> · 权限类别：
            <code>{proposal.risk}</code>
          </p>
          <details open={!!pending}>
            <summary>查看本次发送参数（敏感内容已脱敏）</summary>
            <pre aria-label="MCP 发送参数">
              {JSON.stringify(proposal.arguments, null, 2)}
            </pre>
          </details>
          <small>
            仅授权这一次调用、当前工具 schema
            和连接版本；管理员保存的服务密钥不会展示在页面上。
          </small>
        </>
      )}
      {pending && (
        <div className={styles.actions}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(op, 'approved')}
          >
            批准这一次执行
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAct(op, 'rejected')}
          >
            拒绝
          </button>
          <small>
            授权有效期至 {new Date(request.expiresAt).toLocaleString()}
            。批准不代表已经完成。
          </small>
        </div>
      )}
      {op.approval?.response && (
        <p>
          你的决定：
          {op.approval.response.decision === 'approved'
            ? '已批准本次操作'
            : '已拒绝本次操作'}
          {op.approval.revokedAt ? ' · 后续已撤销' : ''}
        </p>
      )}
      {!terminal && op.snapshot.status !== 'cancel_requested' && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(op, 'cancel')}
        >
          请求停止本轮全部操作
        </button>
      )}
      {['cancel_requested', 'unknown'].includes(op.snapshot.status) && (
        <p role="status" className={styles.notice}>
          已记录的停止指令不等于远端已经停止。
          {proposal.kind === 'mcp'
            ? '第三方服务可能已经产生影响，请先核实服务记录；不会自动重放此调用。'
            : '云端需等待实际停止和结果回执；不会自动重跑脚本。'}
        </p>
      )}
      {op.result && (
        <details>
          <summary>
            执行返回内容（不可信数据）
            {op.result.code ? ` · ${op.result.code}` : ''}
          </summary>
          <pre>{op.result.output || '没有可展示的输出。'}</pre>
        </details>
      )}
    </article>
  );
}
export function CloudOperationPanel({
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
  const [operations, setOperations] = useState<CloudOperationView[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const responses = useRef(new Map<string, unknown>());
  const api = `/api/v1/runtime/cloud-operations?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`,
    headerKey = JSON.stringify(tenantHeaders);
  const active =
    runActive ||
    operations.some(
      (op) =>
        !['succeeded', 'failed', 'canceled', 'partial'].includes(
          op.snapshot.status,
        ),
    );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(api, {
          headers: JSON.parse(headerKey) as Record<string, string>,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('云端操作状态读取失败，请刷新重试。');
        const data = (await response.json()) as {
          operations: CloudOperationView[];
        };
        if (!controller.signal.aborted) {
          setOperations(data.operations);
          setError('');
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '读取失败');
      }
      if (active && !controller.signal.aborted)
        timer = setTimeout(() => void load(), 1500);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, headerKey, active, revision]);
  async function act(op: CloudOperationView, decision: Decision) {
    const request = op.approval?.request;
    if (busy || (decision !== 'cancel' && !request)) return;
    setBusy(true);
    setError('');
    try {
      let body: unknown = { runId, action: 'cancel' };
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
          body: JSON.stringify(body),
        },
      );
      if (!response.ok)
        throw Error(
          '操作未确认：授权可能过期、被撤销或已在其他页面处理。请刷新状态核实，勿重复执行。',
        );
      setRevision((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : '提交失败，请核实当前状态。',
      );
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  if (!operations.length && !error) return null;
  return (
    <section className={styles.root} aria-label="云端计算与 MCP 操作审批">
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新状态
          </button>
        </p>
      )}
      {operations.map((op) => (
        <CloudOperationCard
          key={op.snapshot.binding.attempt.operationId}
          op={op}
          busy={busy}
          onAct={(operation, decision) => void act(operation, decision)}
        />
      ))}
    </section>
  );
}
