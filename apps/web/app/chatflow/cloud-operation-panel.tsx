'use client';
import { ProjectServiceCard } from './project-service-card';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
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

/** Compact receipts never turn an unconfirmed outcome into success or failure. */
export function cloudOperationCompactStatus(op: CloudOperationView) {
  switch (op.snapshot.status) {
    case 'running':
      return '执行中';
    case 'succeeded':
      return '成功';
    case 'failed':
      return '失败';
    case 'planned':
      return '准备中';
    case 'ready':
      return '待执行';
    case 'dispatched':
      return '待确认';
    case 'cancel_requested':
      return '停止待确认';
    case 'unknown':
      return '结果待确认';
    case 'canceled':
      return '已取消';
    case 'partial':
      return '部分完成';
    default:
      return cloudOperationDisplayStatus(op);
  }
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
type OperationSection = {
  key: string;
  label: string;
  title: string;
  value: ReactNode;
  content: ReactNode;
};

function OperationDetails({
  sections,
  initialSection,
}: {
  sections: OperationSection[];
  initialSection: string | null;
}) {
  const [selected, setSelected] = useState(initialSection);
  const panelId = useId();
  const section = sections.find((item) => item.key === selected);
  return (
    <>
      <div className={styles.detailSections} aria-label="执行摘要">
        {sections.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.detailChoice}
            aria-label={item.title}
            aria-expanded={selected === item.key}
            aria-controls={panelId}
            onClick={() =>
              setSelected((current) => (current === item.key ? null : item.key))
            }
          >
            <span className={styles.detailLabel}>{item.label}</span>
            <span className={styles.detailMeta}>{item.value}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>
        ))}
      </div>
      <div id={panelId} hidden={!section} className={styles.detailBody}>
        {section && (
          <>
            <div className={styles.detailHeading}>
              <strong>{section.title}</strong>
              <button
                type="button"
                aria-label="关闭当前详情"
                onClick={() => setSelected(null)}
              >
                ×
              </button>
            </div>
          </>
        )}
        {sections.map((item) => (
          <div
            key={item.key}
            hidden={item.key !== selected}
            className={styles.detailContent}
          >
            {item.content}
          </div>
        ))}
      </div>
    </>
  );
}

function DetailFields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className={styles.fields}>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RawDetail({
  title,
  children,
  open = false,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className={styles.rawDetail} open={open}>
      <summary>
        <IconChevronRightOutlineRegular size={12} />
        {title}
      </summary>
      {children}
    </details>
  );
}

function serviceHost(endpoint: string) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '第三方应用';
  }
}

function mcpRiskLabel(risk: string) {
  return (
    (
      {
        read: '读取',
        read_only: '读取',
        external_send: '对外发送',
        high_risk_data: '敏感数据',
        write: '写入',
        destructive: '删除或破坏性操作',
      } as Record<string, string>
    )[risk] ?? risk
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
  projectServiceContext,
}: {
  op: CloudOperationView;
  projectServiceContext?: {
    workspaceId: string;
    tenantHeaders: Record<string, string>;
    onChanged: () => void;
  };
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
  const isMcp = proposal.kind === 'mcp';
  const fullStatus = laterSuccessId
    ? '本次未成功 · 后续调用已成功'
    : cloudOperationDisplayStatus(op);
  const detailsToggle = (
    <button
      type="button"
      className={styles.detailsToggle}
      aria-label={detailsOpen ? '收起详情' : '查看详情'}
      aria-expanded={detailsOpen}
      aria-controls={detailsId}
      onClick={() => setDetailsOpen((open) => !open)}
    >
      <span>{detailsOpen ? '收起详情' : '查看详情'}</span>
      <IconChevronDownOutlineRegular size={14} />
    </button>
  );
  const stopButton = !terminal && runActive && (
    <Tooltip
      label="请求停止本轮全部操作，已完成的结果会保留。"
      side="top"
      align="end"
    >
      <button
        type="button"
        className={styles.stopButton}
        aria-label={stopping ? '正在停止本轮全部操作' : '请求停止本轮全部操作'}
        disabled={busy || stopping}
        onClick={() => onAct(op, 'cancel')}
      >
        <span className={styles.stopIcon} aria-hidden="true" />
        <span className={styles.stopLabel}>
          {stopping ? '正在停止…' : '停止本轮'}
        </span>
      </button>
    </Tooltip>
  );
  const notices = (
    <>
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
    </>
  );
  const decisionReceipt = op.approval?.response && (
    <p>
      你的决定：
      {op.approval.response.decision === 'approved'
        ? '已批准本次操作'
        : '已拒绝本次操作'}
      {op.approval.revokedAt ? ' · 后续已撤销' : ''}
    </p>
  );
  const receiptNotes = (
    <>
      {(op.snapshot.status === 'cancel_requested' ||
        (op.snapshot.status === 'unknown' && !failure)) && (
        <p role="status" className={styles.notice}>
          {op.snapshot.status === 'cancel_requested'
            ? '已记录的停止指令不等于远端已经停止。'
            : '未收到完整的执行回执。'}
          {proposal.kind === 'mcp'
            ? '第三方服务可能已经产生影响，请先核实服务记录；不会自动重放此调用。'
            : '云端需等待实际停止和结果回执；不会自动重跑任务。'}
        </p>
      )}
    </>
  );
  const plannedOutputs = proposal.kind !== 'mcp' && (
    <p className={styles.plannedOutputs}>
      <span>计划输出：</span>
      {proposal.outputs?.length
        ? proposal.outputs.map((output) => (
            <code key={output.path}>
              {output.fileName} ({output.format})
            </code>
          ))
        : '无'}
    </p>
  );
  const resultSection: OperationSection = {
    key: 'result',
    label: '结果',
    title: '执行结果',
    value: cloudOperationCompactStatus(op),
    content: (
      <>
        <DetailFields
          rows={[
            ['状态', fullStatus],
            ['返回代码', op.result?.code ?? '尚无'],
          ]}
        />
        {op.result ? (
          <>
            <RawDetail title="查看原始返回内容">
              <pre>{op.result.output || '没有可展示的输出。'}</pre>
              <small>工具原始返回内容（不可信数据），仅作执行记录。</small>
            </RawDetail>
          </>
        ) : (
          <p>尚未收到执行返回内容。</p>
        )}
        {decisionReceipt}
        {plannedOutputs}
      </>
    ),
  };
  let sections: OperationSection[];
  if (proposal.kind === 'mcp') {
    const argumentCount =
      proposal.arguments && typeof proposal.arguments === 'object'
        ? Object.keys(proposal.arguments).length
        : 0;
    const authorization = mcpUnavailable
      ? mcpAuthorizationLabel(op)
      : op.approval?.revokedAt
        ? '授权已撤销'
        : op.approval?.response?.decision === 'rejected'
          ? '本次拒绝'
          : request &&
              Date.parse(request.expiresAt) <= Date.now() &&
              !op.approval?.response
            ? '本次授权已过期'
            : op.approval?.response?.decision === 'approved'
              ? '本次批准'
              : pending
                ? '等待批准'
                : '按现有授权';
    sections = [
      {
        key: 'app',
        label: '应用',
        title: '应用与工具',
        value: serviceHost(proposal.endpoint),
        content: (
          <DetailFields
            rows={[
              ['服务', serviceHost(proposal.endpoint)],
              ['连接', proposal.endpoint],
              ['工具名', <code key="tool">{proposal.tool}</code>],
            ]}
          />
        ),
      },
      {
        key: 'arguments',
        label: '操作',
        title: '发送参数',
        value: `${mcpRiskLabel(proposal.risk)} · ${argumentCount} 项`,
        content: (
          <>
            <DetailFields
              rows={[
                ['操作类别', mcpRiskLabel(proposal.risk)],
                ['参数数量', `${argumentCount} 项（已脱敏）`],
              ]}
            />
            <RawDetail title="查看完整参数" open={!!pending}>
              <pre aria-label="MCP 发送参数">
                {JSON.stringify(proposal.arguments, null, 2)}
              </pre>
            </RawDetail>
          </>
        ),
      },
      {
        key: 'authorization',
        label: '授权',
        title: '本次授权',
        value: authorization,
        content: (
          <DetailFields
            rows={[
              ['授权', authorization],
              ['适用范围', '仅授权这一次调用、当前工具 schema 和连接版本。'],
              [
                '操作影响',
                '服务在 AllRice 沙箱之外运行，可能读取或修改其账号内的数据。',
              ],
              ...(request
                ? [
                    [
                      '有效期',
                      new Date(request.expiresAt).toLocaleString(),
                    ] as [string, ReactNode],
                  ]
                : []),
            ]}
          />
        ),
      },
      resultSection,
    ];
  } else {
    const runtime =
      proposal.kind === 'project'
        ? proposal.preparation.manager === 'uv'
          ? 'Python 3.11'
          : 'Node.js 22'
        : proposal.language === 'python'
          ? 'Python 3.11'
          : 'Node.js 22';
    const limits = proposal.limits;
    sections = [
      proposal.kind === 'project'
        ? {
            key: 'execution',
            label: '命令',
            title: '执行命令',
            value: runtime,
            content: (
              <>
                <DetailFields
                  rows={[
                    ['运行环境', runtime],
                    ['执行位置', '云端 · 不联网'],
                    ['执行程序', proposal.executable],
                    ['工作目录', proposal.path],
                  ]}
                />
                <p>执行本次保存的项目副本，不访问你的电脑。</p>
                <RawDetail title="查看完整命令" open={!!pending}>
                  <pre aria-label="云端项目命令">
                    {JSON.stringify(
                      {
                        executable: proposal.executable,
                        args: proposal.args,
                        path: proposal.path,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </RawDetail>
              </>
            ),
          }
        : {
            key: 'execution',
            label: '脚本',
            title: '执行脚本',
            value: runtime,
            content: (
              <>
                <DetailFields
                  rows={[
                    ['运行环境', runtime],
                    ['执行位置', '云端 · 不联网'],
                    ['文件范围', '只读本次授权的上传文件，不访问你的电脑。'],
                  ]}
                />
                <RawDetail title="查看完整脚本" open={!!pending}>
                  <pre aria-label="云端待执行脚本">{proposal.script}</pre>
                </RawDetail>
              </>
            ),
          },
      proposal.kind === 'project'
        ? {
            key: 'inputs',
            label: '版本',
            title: '项目版本',
            value: `${proposal.files.length} 个文件`,
            content: (
              <>
                <DetailFields
                  rows={[
                    ['文件数量', `${proposal.files.length} 个`],
                    [
                      '版本摘要',
                      <code key="digest">{proposal.sourceDigest}</code>,
                    ],
                  ]}
                />
                <RawDetail title="查看项目与文件记录">
                  <pre>
                    {JSON.stringify(
                      {
                        project: proposal.project,
                        sourceDigest: proposal.sourceDigest,
                        files: proposal.files,
                        preparation: proposal.preparation,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </RawDetail>
              </>
            ),
          }
        : {
            key: 'inputs',
            label: '输入',
            title: '输入文件',
            value: `${proposal.inputs.length} 个文件`,
            content: proposal.inputs.length ? (
              <ul className={styles.inputFiles}>
                {proposal.inputs.map((file) => (
                  <li key={file.objectId}>
                    <DetailFields
                      rows={[
                        ['文件路径', file.path],
                        ['文件 ID', file.objectId],
                        ['校验值', <code key="checksum">{file.checksum}</code>],
                      ]}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p>无输入文件。</p>
            ),
          },
      {
        key: 'limits',
        label: '限制',
        title: '运行限制',
        value: `${limits.timeoutMs / 1000} 秒 · ${limits.memoryMiB} MiB`,
        content: (
          <DetailFields
            rows={[
              ['时限', `${limits.timeoutMs / 1000} 秒`],
              ['内存', `${limits.memoryMiB} MiB`],
              ['CPU', `${limits.cpuMillis} 毫核`],
              ['进程数上限', limits.pids],
              ['输出上限', `${limits.outputBytes} 字节`],
              ...('artifactBytes' in limits
                ? [
                    ['成果上限', `${limits.artifactBytes} 字节`] as [
                      string,
                      ReactNode,
                    ],
                  ]
                : []),
            ]}
          />
        ),
      },
      resultSection,
    ];
  }
  return (
    <article
      className={styles.card}
      id={`operation-${op.snapshot.binding.attempt.operationId}`}
      data-status={op.snapshot.status}
    >
      {op.projectService && projectServiceContext && (
        <ProjectServiceCard
          service={op.projectService}
          {...projectServiceContext}
        />
      )}
      <header className={styles.cloudHeader}>
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
              {isMcp ? (
                <>
                  <rect x="3" y="8" width="8" height="13" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <path d="M3 14h14a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 17 21h-7" />
                </>
              ) : (
                <path d="M6 18h12a4 4 0 0 0 .5-8A6.5 6.5 0 0 0 6 8a5 5 0 0 0 0 10Z" />
              )}
            </svg>
          </span>
          {proposal.kind === 'mcp'
            ? '应用工具'
            : proposal.kind === 'project'
              ? '云端项目'
              : '云端计算'}
        </strong>
        <p className={styles.cloudScope}>
          {proposal.kind === 'mcp' ? (
            <>
              <span className={styles.serviceHost} title={proposal.endpoint}>
                {serviceHost(proposal.endpoint)}
              </span>
              <span>{mcpRiskLabel(proposal.risk)}</span>
            </>
          ) : (
            <>
              <span>
                {proposal.kind === 'project'
                  ? proposal.files.length
                  : proposal.inputs.length}{' '}
                个输入文件
              </span>
              <span className={styles.cloudLocation}>仅在云端执行</span>
              <span>不联网</span>
            </>
          )}
        </p>
        <div className={styles.cloudControls}>
          <Tooltip label={fullStatus} side="top" align="end">
            <span
              className={styles.status}
              role="status"
              aria-label={fullStatus}
            >
              {isMcp &&
              !['succeeded', 'failed', 'running'].includes(op.snapshot.status)
                ? cloudOperationCompactStatus(op)
                : isMcp
                  ? labels[op.snapshot.status]
                  : fullStatus}
            </span>
          </Tooltip>
          {detailsToggle}
          {stopButton}
        </div>
      </header>
      {!isMcp && notices}
      <div id={detailsId} hidden={!detailsOpen}>
        <OperationDetails
          key={`${op.snapshot.binding.attempt.operationId}-${!!pending}`}
          sections={sections}
          initialSection={pending ? (isMcp ? 'arguments' : 'execution') : null}
        />
        {isMcp && (
          <div className={styles.receiptNotes}>
            {notices}
            {receiptNotes}
          </div>
        )}
      </div>
      {pending && (
        <div className={styles.approvalReview}>
          {isMcp && (
            <p className={styles.notice}>
              批准后，会将列出的参数发送给此第三方服务；服务在 AllRice
              沙箱之外运行，可能读取或修改其账号内的数据。仅授权这一次调用、当前工具
              schema 和连接版本；管理员保存的服务密钥不会展示在页面上。
            </p>
          )}
          {plannedOutputs}
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
        </div>
      )}
      {!isMcp && receiptNotes}
    </article>
  );
}
export function CloudOperationPanel({
  runId,
  workspaceId,
  tenantHeaders,
  runActive,
  children,
}: {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
  children?: (feed: {
    operations: CloudOperationView[];
    renderOperation: (operationId: string) => ReactNode;
    feedback: ReactNode;
  }) => ReactNode;
}) {
  const [operations, setOperations] = useState<CloudOperationView[]>([]),
    [loadError, setLoadError] = useState(''),
    [actionError, setActionError] = useState(''),
    [retrying, setRetrying] = useState(false),
    [readUpdated, setReadUpdated] = useState(false),
    [busy, setBusy] = useState(false),
    [pendingDecision, setPendingDecision] = useState<Decision | null>(null),
    [cancellationRunId, setCancellationRunId] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const responses = useRef(new Map<string, unknown>());
  const manualRetry = useRef(false);
  const api = `/api/v1/runtime/cloud-operations?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`,
    headerKey = JSON.stringify(tenantHeaders);
  const active = cloudOperationsNeedPolling(runActive, operations);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(api, {
          headers: JSON.parse(headerKey) as Record<string, string>,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw Error('operation_status_unavailable');
        const data = (await response.json()) as {
          operations: CloudOperationView[];
        };
        if (!controller.signal.aborted) {
          setOperations(data.operations);
          setLoadError('');
          if (manualRetry.current) setReadUpdated(true);
        }
      } catch {
        if (!controller.signal.aborted) setLoadError('操作状态读取失败');
      } finally {
        if (!controller.signal.aborted && manualRetry.current) {
          manualRetry.current = false;
          setRetrying(false);
        }
      }
      if (active && !controller.signal.aborted)
        timer = setTimeout(() => void load(), 1500);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, headerKey, active, revision, runId]);
  async function act(op: CloudOperationView, decision: Decision) {
    const request = op.approval?.request;
    if (busy || (decision !== 'cancel' && !request)) return;
    setBusy(true);
    setPendingDecision(decision);
    setActionError('');
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
      setActionError(
        error instanceof Error ? error.message : '提交失败，请核实当前状态。',
      );
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
      setPendingDecision(null);
    }
  }
  const readFeedback = readUpdated
    ? operations.some((op) => op.snapshot.status === 'unknown')
      ? '已读取最新状态，结果仍待确认。'
      : '操作状态已更新。'
    : '';
  const feedback = (
    <>
      {actionError && (
        <p className={styles.feedbackError} role="alert">
          {actionError}
        </p>
      )}
      {loadError && (
        <p className={styles.feedbackError} role="alert">
          <span>{loadError}</span>
          <button
            className={styles.readRetry}
            type="button"
            aria-label="重试读取操作状态"
            aria-busy={retrying}
            disabled={retrying}
            onClick={() => {
              manualRetry.current = true;
              setRetrying(true);
              setReadUpdated(false);
              setRevision((value) => value + 1);
            }}
          >
            {retrying ? (
              <span className={styles.readRetrySpinner} aria-hidden="true">
                <IconLoadingOutlineRegular size={14} />
              </span>
            ) : (
              <IconRefreshOutlineRegular size={14} />
            )}
            {retrying ? '读取中…' : '重试'}
          </button>
        </p>
      )}
      {readFeedback && !loadError && (
        <p className={styles.readFeedback} role="status">
          {readFeedback}
        </p>
      )}
    </>
  );
  const renderOperation = (operationId: string) => {
    const op = operations.find(
      (op) => op.snapshot.binding.attempt.operationId === operationId,
    );
    return op ? (
      <CloudOperationCard
        projectServiceContext={{
          workspaceId,
          tenantHeaders,
          onChanged: () => setRevision((value) => value + 1),
        }}
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
    ) : null;
  };
  if (children) return children({ operations, renderOperation, feedback });
  if (!operations.length && !loadError && !actionError && !readFeedback)
    return null;
  return (
    <section className={styles.root} aria-label="云端计算与 MCP 操作审批">
      {feedback}
      {operations.map((op) =>
        renderOperation(op.snapshot.binding.attempt.operationId),
      )}
    </section>
  );
}
