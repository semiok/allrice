'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  IconChevronRightOutlineRegular,
  IconCodeOutlineRegular,
  IconCopyOutlineRegular,
  IconFlatListOutlineRegular,
  IconSlidersTwoOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { classifyMcpFailure, mcpFailureCopy } from '@allrice/contracts';
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
  succeeded: '执行成功',
  failed: '执行未成功',
  canceled: '已确认未执行或停止',
  partial: '部分完成',
};
function operationFailure(op: CloudOperationView) {
  return op.proposal.kind === 'mcp' &&
    ['failed', 'unknown'].includes(op.snapshot.status)
    ? classifyMcpFailure({
        code:
          op.result?.code ??
          (op.snapshot.status === 'unknown' ? 'MCP_UNKNOWN' : null),
        output: op.result?.output,
        endpoint: op.proposal.endpoint,
        tool: op.proposal.tool,
      })
    : null;
}

export function cloudOperationsNeedPolling(
  runActive: boolean,
  operations: CloudOperationView[],
) {
  return (
    runActive ||
    operations.some((op) =>
      [
        'planned',
        'waiting_user',
        'ready',
        'dispatched',
        'running',
        'cancel_requested',
      ].includes(op.snapshot.status),
    )
  );
}

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
  const failure = operationFailure(op);
  if (failure) return mcpFailureCopy[failure].title;
  return labels[op.snapshot.status] ?? op.snapshot.status;
}
type Decision = 'approved' | 'rejected' | 'cancel';

/** A later success is context, not a rewrite of this call's failure receipt. */
export function laterSuccessfulMcpCall(
  op: CloudOperationView,
  operations: CloudOperationView[],
) {
  const proposal = op.proposal;
  if (
    proposal.kind !== 'mcp' ||
    op.snapshot.status !== 'failed' ||
    op.snapshot.result?.effects !== 'none'
  )
    return undefined;
  const failedAt = Date.parse(op.snapshot.result.evidence.recordedAt);
  return operations.find(
    (candidate) =>
      candidate.proposal.kind === 'mcp' &&
      candidate.proposal.endpoint === proposal.endpoint &&
      candidate.proposal.tool === proposal.tool &&
      candidate.snapshot.binding.execution.targetId ===
        op.snapshot.binding.execution.targetId &&
      candidate.snapshot.binding.task.runId ===
        op.snapshot.binding.task.runId &&
      candidate.snapshot.status === 'succeeded' &&
      candidate.snapshot.result &&
      Date.parse(candidate.snapshot.result.evidence.recordedAt) > failedAt,
  )?.snapshot.binding.attempt.operationId;
}
function OperationDetail({
  icon,
  title,
  meta,
  open = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={styles.detailSection} open={open}>
      <summary>
        <span className={styles.detailIcon} aria-hidden="true">
          {icon}
        </span>
        <span className={styles.detailLabel}>{title}</span>
        {meta && <span className={styles.detailMeta}>{meta}</span>}
        <span className={styles.detailChevron} aria-hidden="true">
          <IconChevronRightOutlineRegular size={14} />
        </span>
      </summary>
      <div className={styles.detailBody}>{children}</div>
    </details>
  );
}
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
  cancelPending = false,
  runActive = true,
  laterSuccessId,
  onAct,
}: {
  op: CloudOperationView;
  busy: boolean;
  cancelPending?: boolean;
  runActive?: boolean;
  laterSuccessId?: string;
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
  const failure = operationFailure(op);
  const stopping = cancelPending || op.snapshot.status === 'cancel_requested';
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(!!pending);
  useEffect(() => {
    setDetailsOpen(!!pending);
  }, [pending, op.snapshot.binding.attempt.operationId]);
  return (
    <article
      className={styles.card}
      id={`operation-${op.snapshot.binding.attempt.operationId}`}
      data-status={op.snapshot.status}
    >
      <header>
        <strong className={styles.title}>
          <span className={styles.icon} aria-hidden="true">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
            >
              {proposal.kind === 'cloud' ? (
                <path d="M6 18h12a4 4 0 0 0 .5-8A6.5 6.5 0 0 0 6 8a5 5 0 0 0 0 10Z" />
              ) : (
                <>
                  <rect x="3" y="8" width="8" height="13" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <path d="M3 14h14a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 17 21h-7" />
                </>
              )}
            </svg>
          </span>
          {proposal.kind === 'cloud' ? '云端计算' : '应用工具'}
        </strong>
        <span className={styles.status} role="status">
          {laterSuccessId
            ? '本次未成功 · 后续调用已成功'
            : cloudOperationDisplayStatus(op)}
        </span>
      </header>
      {laterSuccessId && (
        <p className={styles.notice}>
          同一应用工具的后续调用已成功，本次失败记录仍保留。
          <a href={`#operation-${laterSuccessId}`}>查看成功结果</a>
        </p>
      )}
      {!op.enabled && (
        <p className={styles.notice}>
          新执行已停用；保留已有记录与授权状态，仍可请求停止本轮。
        </p>
      )}
      {mcpUnavailable && (
        <p role="status" className={styles.notice}>
          {mcpAuthorizationLabel(op)}。不能再批准此操作；未派发的操作不会执行。
          已派发的操作不等于已经停止，请核实返回记录。历史结果仍保留。
          {!terminal && runActive && '仍可请求停止本轮。'}
        </p>
      )}
      {failure && (
        <p role="status" className={styles.notice}>
          {!runActive && '本轮已结束。'}
          {mcpFailureCopy[failure].detail}
        </p>
      )}
      <p className={styles.scope}>
        {proposal.kind === 'cloud'
          ? `${proposal.inputs.length} 个输入文件 · 仅在云端执行 · 不联网`
          : `第三方应用 · ${proposal.tool}`}
      </p>
      <div className={styles.executionFooter}>
        <div className={styles.executionToolbar}>
          <span className={styles.executionTitle}>运行详情</span>
          <div className={styles.executionControls}>
            <button
              type="button"
              className={styles.detailsToggle}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              onClick={() => setDetailsOpen((open) => !open)}
            >
              <span>{detailsOpen ? '收起详情' : '查看详情'}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d={detailsOpen ? 'M3 8h10' : 'M3 8h10M8 3v10'}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {!terminal && runActive && (
              <Tooltip
                label="请求停止本轮全部操作，已完成的结果会保留。"
                side="top"
                align="end"
              >
                <button
                  type="button"
                  className={styles.stopButton}
                  aria-label={
                    stopping ? '正在停止本轮全部操作' : '请求停止本轮全部操作'
                  }
                  disabled={busy || stopping}
                  onClick={() => onAct(op, 'cancel')}
                >
                  <span className={styles.stopIcon} aria-hidden="true" />
                  <span className={styles.stopLabel}>
                    {stopping ? '正在停止…' : '停止本轮'}
                  </span>
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div
          id={detailsId}
          className={styles.executionBody}
          hidden={!detailsOpen}
        >
          {proposal.kind === 'cloud' ? (
            <p className={styles.detailScope}>
              只读本次授权的上传文件，不访问你的电脑。
            </p>
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
            </>
          )}
          <div className={styles.detailSections}>
            {proposal.kind === 'cloud' ? (
              <>
                <OperationDetail
                  title="执行脚本"
                  meta="Node.js"
                  icon={<IconCodeOutlineRegular size={16} />}
                  open={!!pending}
                >
                  <pre aria-label="云端待执行脚本">{proposal.script}</pre>
                </OperationDetail>
                <OperationDetail
                  title="输入文件"
                  meta={`${proposal.inputs.length} 个`}
                  icon={<IconCopyOutlineRegular size={16} />}
                  open={!!pending}
                >
                  {proposal.inputs.length ? (
                    <ul className={styles.inputFiles}>
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
                </OperationDetail>
                <OperationDetail
                  title="运行限制"
                  meta={`${proposal.limits.timeoutMs / 1000} 秒 · ${proposal.limits.memoryMiB} MiB`}
                  icon={<IconSlidersTwoOutlineRegular size={16} />}
                  open={!!pending}
                >
                  <dl className={styles.limits}>
                    <div>
                      <dt>时限</dt>
                      <dd>{proposal.limits.timeoutMs / 1000} 秒</dd>
                    </div>
                    <div>
                      <dt>内存</dt>
                      <dd>{proposal.limits.memoryMiB} MiB</dd>
                    </div>
                    <div>
                      <dt>CPU</dt>
                      <dd>{proposal.limits.cpuMillis} 毫核</dd>
                    </div>
                    <div>
                      <dt>进程数上限</dt>
                      <dd>{proposal.limits.pids}</dd>
                    </div>
                    <div>
                      <dt>输出上限</dt>
                      <dd>{proposal.limits.outputBytes} 字节</dd>
                    </div>
                    <div>
                      <dt>成果上限</dt>
                      <dd>{proposal.limits.artifactBytes} 字节</dd>
                    </div>
                  </dl>
                </OperationDetail>
              </>
            ) : (
              <OperationDetail
                title="发送参数"
                meta="已脱敏"
                icon={<IconCodeOutlineRegular size={16} />}
                open={!!pending}
              >
                <pre aria-label="MCP 发送参数">
                  {JSON.stringify(proposal.arguments, null, 2)}
                </pre>
              </OperationDetail>
            )}
            {op.result && (
              <OperationDetail
                title="执行返回内容"
                meta={op.result.code}
                icon={<IconFlatListOutlineRegular size={16} />}
              >
                <pre>{op.result.output || '没有可展示的输出。'}</pre>
                <small>工具原始返回内容（不可信数据），仅作执行记录。</small>
              </OperationDetail>
            )}
          </div>
          {proposal.kind === 'cloud' ? (
            <p className={styles.plannedOutputs}>
              <span>计划输出：</span>
              {proposal.outputs.length
                ? proposal.outputs.map((output) => (
                    <code key={output.path}>
                      {output.fileName} ({output.format})
                    </code>
                  ))
                : '无'}
            </p>
          ) : (
            <small className={styles.authorizationScope}>
              仅授权这一次调用、当前工具 schema
              和连接版本；管理员保存的服务密钥不会展示在页面上。
            </small>
          )}
        </div>
      </div>
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
      {(op.snapshot.status === 'cancel_requested' ||
        (op.snapshot.status === 'unknown' && !failure)) && (
        <p role="status" className={styles.notice}>
          {op.snapshot.status === 'cancel_requested'
            ? '已记录的停止指令不等于远端已经停止。'
            : '未收到完整的执行回执。'}
          {proposal.kind === 'mcp'
            ? '第三方服务可能已经产生影响，请先核实服务记录；不会自动重放此调用。'
            : '云端需等待实际停止和结果回执；不会自动重跑脚本。'}
        </p>
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
    [pendingDecision, setPendingDecision] = useState<Decision | null>(null),
    [cancellationRunId, setCancellationRunId] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const responses = useRef(new Map<string, unknown>());
  const api = `/api/v1/runtime/cloud-operations?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`,
    headerKey = JSON.stringify(tenantHeaders);
  const active = cloudOperationsNeedPolling(runActive, operations);
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
    setPendingDecision(decision);
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
      if (decision === 'cancel') setCancellationRunId(runId);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : '提交失败，请核实当前状态。',
      );
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
      setPendingDecision(null);
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
      {!runActive &&
        operations.some((op) => op.snapshot.status === 'unknown') && (
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新操作状态
          </button>
        )}
      {operations.map((op) => (
        <CloudOperationCard
          key={op.snapshot.binding.attempt.operationId}
          op={op}
          runActive={runActive}
          laterSuccessId={laterSuccessfulMcpCall(op, operations)}
          busy={busy}
          cancelPending={
            pendingDecision === 'cancel' ||
            (cancellationRunId === runId && op.snapshot.status !== 'unknown')
          }
          onAct={(operation, decision) => void act(operation, decision)}
        />
      ))}
    </section>
  );
}
