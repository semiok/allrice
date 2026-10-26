'use client';
import { ProjectServiceCard } from './project-service-card';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  IconChevronDownOutlineRegular,
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import {
  classifyMcpFailure,
  sandboxNetworkErrorMessage,
  projectResolutionErrorMessage,
} from '@allrice/contracts';
import type { CloudOperationView } from '@allrice/database';
import styles from './cloud-operation-panel.module.css';
import { TechnicalDetails } from './technical-details';
import {
  approvalSummary,
  approveLabel,
  cloudOperationCompactLabel,
  cloudOperationStatusLabel,
  durationText,
  mcpApprovalDetails,
  mcpAuthorizationLabel,
  mcpFailureNotice,
  mcpRiskLabel,
  resourceLimitRows,
  resultNote,
  serviceHost,
  unconfirmedNote,
} from '../../lib/chatflow/cloud-operation-presenter';
import { shortDateTime } from '../../lib/chatflow/browser-workspace-presenter';

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
    if (op.approval.revokedAt) return '已撤回，没有执行';
    if (op.approval.response?.decision === 'rejected')
      return '你已拒绝，没有执行';
    if (op.approval.response?.decision === 'approved')
      return '你已允许，正在准备';
    if (Date.parse(op.approval.request.expiresAt) <= now)
      return '已过期，没有执行';
    if (op.proposal.kind === 'mcp' && op.mcpAuthorization?.available !== true)
      return mcpAuthorizationLabel(op.mcpAuthorization?.reason);
  }
  const failure = operationFailure(op);
  if (failure) return mcpFailureNotice(failure).title;
  return cloudOperationStatusLabel(op.snapshot.status);
}

/** Compact receipts never turn an unconfirmed outcome into success or failure. */
export function cloudOperationCompactStatus(
  op: CloudOperationView,
  now = Date.now(),
) {
  return cloudOperationCompactLabel(op, now);
}

/** One pending parameter; a long value can be read in full on request. */
function ApprovalField({
  name,
  text,
  full,
}: {
  name: string;
  text: string;
  full: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      {name}：{open ? full : text}
      {full !== text && (
        <Button
          className={styles.decision}
          size="sm"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起' : '展开全文'}
        </Button>
      )}
    </li>
  );
}

/** What a pending app call will do: decision material, not technical detail. */
function McpApprovalDetails({
  proposal,
}: {
  proposal: Extract<CloudOperationView['proposal'], { kind: 'mcp' }>;
}) {
  const details = mcpApprovalDetails(proposal);
  return (
    <dl className={styles.fields} aria-label="这次要做的事">
      <div>
        <dt>动作</dt>
        <dd>{details.action}</dd>
      </div>
      <div>
        <dt>对象</dt>
        <dd>{details.target}</dd>
      </div>
      <div>
        <dt>内容</dt>
        <dd>
          {details.fields.length ? (
            <ul className={styles.approvalFields}>
              {details.fields.map((field) => (
                <ApprovalField
                  key={field.key}
                  name={field.key}
                  text={field.text}
                  full={field.full}
                />
              ))}
            </ul>
          ) : (
            '没有参数'
          )}
        </dd>
      </div>
    </dl>
  );
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
  const networkFailure =
    proposal.kind !== 'mcp' &&
    proposal.network &&
    ['failed', 'unknown', 'canceled'].includes(op.snapshot.status)
      ? sandboxNetworkErrorMessage(op.result?.code)
      : undefined;
  const resolutionFailure =
    proposal.kind === 'cloud' &&
    proposal.dependencyResolution &&
    op.snapshot.status === 'failed'
      ? projectResolutionErrorMessage(op.result?.code ?? undefined)
      : undefined;
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(!!pending);
  useEffect(() => {
    setDetailsOpen(!!pending);
  }, [pending, op.snapshot.binding.attempt.operationId]);
  const isMcp = proposal.kind === 'mcp';
  const fullStatus = laterSuccessId
    ? '这次未完成，之后再试已完成'
    : proposal.kind === 'cloud' &&
        proposal.dependencyResolution &&
        op.snapshot.status === 'succeeded'
      ? '已查到可用版本，还没安装'
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
      {resolutionFailure && (
        <p role="status" className={styles.notice} data-tone="error">
          {resolutionFailure}
        </p>
      )}
      {laterSuccessId && (
        <p className={styles.notice}>
          之后再试的一次已经完成，这次的记录仍保留。
          <a href={`#operation-${laterSuccessId}`}>查看完成的那次</a>
        </p>
      )}
      {!op.enabled && (
        <p className={styles.notice}>
          这类操作已暂停使用，不会再开始新的执行，已有记录会保留。
          {!terminal && runActive && '仍可停止本轮。'}
        </p>
      )}
      {mcpUnavailable && (
        <p role="status" className={styles.notice} data-tone="warn">
          {mcpAuthorizationLabel(op.mcpAuthorization?.reason)}
          {terminal
            ? '，不能再允许新的调用；这次调用已经结束，结果仍保留。'
            : '，不能再允许这一步。还没开始的不会执行；已经开始的可能还在进行，请刷新查看结果。'}
          {!terminal && runActive && '仍可停止本轮。'}
        </p>
      )}
      {failure && (
        <p
          role="status"
          className={styles.notice}
          data-tone={failure === 'result_unknown' ? 'warn' : 'error'}
        >
          {!runActive && '本轮已结束。'}
          {mcpFailureNotice(failure).detail}
        </p>
      )}
      {networkFailure && (
        <p
          role="status"
          className={styles.notice}
          data-tone={op.snapshot.status === 'failed' ? 'error' : 'warn'}
        >
          {networkFailure}
        </p>
      )}
    </>
  );
  const decisionReceipt = op.approval?.response && (
    <p>
      {op.approval.response.decision === 'approved'
        ? '你已允许这一步'
        : '你已拒绝这一步'}
      {op.approval.revokedAt ? '，之后已撤回' : ''}
    </p>
  );
  const receiptNotes = (op.snapshot.status === 'cancel_requested' ||
    (op.snapshot.status === 'unknown' && !failure)) && (
    <p role="status" className={styles.notice} data-tone="warn">
      {unconfirmedNote(proposal, op.snapshot.status)}
    </p>
  );
  const plannedOutputs = proposal.kind !== 'mcp' && (
    <p className={styles.plannedOutputs}>
      {proposal.outputs?.length ? (
        <>
          <span>会生成：</span>
          {proposal.outputs.map((output) => (
            <code key={output.path}>{output.fileName}</code>
          ))}
        </>
      ) : (
        '不会生成文件。'
      )}
    </p>
  );
  const nextStep =
    !failure && !networkFailure && !resolutionFailure && !laterSuccessId
      ? resultNote(op.snapshot.status)
      : null;
  const resultSection: OperationSection = {
    key: 'result',
    label: '结果',
    title: '执行结果',
    value: cloudOperationCompactStatus(op),
    content: (
      <>
        <DetailFields rows={[['状态', fullStatus]]} />
        {nextStep && <p>{nextStep}</p>}
        {decisionReceipt}
        {plannedOutputs}
        <TechnicalDetails
          rows={[
            ['操作编号', op.snapshot.binding.attempt.operationId],
            ['状态记录', op.snapshot.status],
            ['返回代码', op.result?.code ?? '无'],
          ]}
        >
          <pre>
            {op.result
              ? op.result.output || '没有返回内容。'
              : '还没有返回内容。'}
          </pre>
        </TechnicalDetails>
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
      ? mcpAuthorizationLabel(op.mcpAuthorization?.reason)
      : op.approval?.revokedAt
        ? '已撤回'
        : op.approval?.response?.decision === 'rejected'
          ? '你已拒绝'
          : request &&
              Date.parse(request.expiresAt) <= Date.now() &&
              !op.approval?.response
            ? '已过期'
            : op.approval?.response?.decision === 'approved'
              ? '你已允许'
              : pending
                ? '等你确认'
                : '按已有授权';
    sections = [
      {
        key: 'app',
        label: '应用',
        title: '应用与工具',
        value: serviceHost(proposal.endpoint),
        content: (
          <>
            <DetailFields
              rows={[
                ['应用', serviceHost(proposal.endpoint)],
                ['操作类别', mcpRiskLabel(proposal.risk)],
              ]}
            />
            <TechnicalDetails
              rows={[
                ['连接地址', proposal.endpoint],
                ['工具名', <code key="tool">{proposal.tool}</code>],
              ]}
            />
          </>
        ),
      },
      {
        key: 'arguments',
        label: '操作',
        title: '发送内容',
        value: `${mcpRiskLabel(proposal.risk)} · ${argumentCount} 项`,
        content: (
          <>
            <DetailFields
              rows={[
                ['操作类别', mcpRiskLabel(proposal.risk)],
                ['发送内容', `${argumentCount} 项`],
              ]}
            />
            <TechnicalDetails>
              <pre aria-label="发送的原始参数">
                {JSON.stringify(proposal.arguments, null, 2)}
              </pre>
            </TechnicalDetails>
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
              [
                '适用范围',
                '只允许这一次调用；应用或权限有变化时需要重新确认。',
              ],
              [
                '可能的影响',
                '这个应用在 AllRice 之外运行，可能读取或修改你在其中的数据。',
              ],
              ...(request
                ? [
                    ['有效期', `${shortDateTime(request.expiresAt)} 前`] as [
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
  } else {
    const networkScope = proposal.network && (
      <div className={styles.detailScope} aria-label="获准访问的外部服务">
        <strong>外部服务</strong>
        <ul>
          {proposal.network.origins.map((origin) => (
            <li key={origin}>{origin}</li>
          ))}
        </ul>
        <p>
          {proposal.kind === 'project'
            ? '本次项目副本中的源码和文件可发送至以上服务。'
            : proposal.inputs.length
              ? '本次输入文件可发送至以上服务。'
              : '本次未提供输入文件。'}
        </p>
      </div>
    );
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
                    [
                      '执行位置',
                      proposal.network ? '云端 · 按授权联网' : '云端 · 不联网',
                    ],
                  ]}
                />
                <p>运行你保存的项目副本，不会访问你的电脑。</p>
                {networkScope}
                <TechnicalDetails
                  rows={[
                    ['执行程序', proposal.executable],
                    ['工作目录', proposal.path],
                  ]}
                >
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
                </TechnicalDetails>
              </>
            ),
          }
        : {
            key: 'execution',
            label: proposal.dependencyResolution ? '依赖' : '脚本',
            title: proposal.dependencyResolution ? '准备依赖' : '执行脚本',
            value: runtime,
            content: (
              <>
                <DetailFields
                  rows={[
                    ['运行环境', runtime],
                    [
                      '执行位置',
                      proposal.network ? '云端 · 按授权联网' : '云端 · 不联网',
                    ],
                    [
                      '文件范围',
                      proposal.dependencyResolution
                        ? '仅查询公开依赖，不读取或发送你的文件。'
                        : '只读本次授权的上传文件，不访问你的电脑。',
                    ],
                  ]}
                />
                {networkScope}
                {proposal.dependencyResolution && (
                  <ul aria-label="请求的依赖版本">
                    {proposal.dependencyResolution.packages.map((p) => (
                      <li key={p.name}>
                        <code>
                          {p.name}@{p.version}
                        </code>
                      </li>
                    ))}
                  </ul>
                )}
                <TechnicalDetails>
                  <pre aria-label="云端待执行脚本">{proposal.script}</pre>
                </TechnicalDetails>
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
                  rows={[['文件数量', `${proposal.files.length} 个`]]}
                />
                <TechnicalDetails
                  rows={[
                    [
                      '版本摘要',
                      <code key="digest">{proposal.sourceDigest}</code>,
                    ],
                  ]}
                >
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
                </TechnicalDetails>
              </>
            ),
          }
        : {
            key: 'inputs',
            label: '输入',
            title: '输入文件',
            value: `${proposal.inputs.length} 个文件`,
            content: proposal.inputs.length ? (
              <>
                <ul className={styles.inputFiles}>
                  {proposal.inputs.map((file) => (
                    <li key={file.objectId}>{file.path}</li>
                  ))}
                </ul>
                <TechnicalDetails
                  rows={proposal.inputs.map((file) => [
                    file.path,
                    `文件编号 ${file.objectId}；校验值 ${file.checksum}`,
                  ])}
                />
              </>
            ) : (
              <p>没有输入文件。</p>
            ),
          },
      {
        key: 'limits',
        label: '限制',
        title: '运行限制',
        value: proposal.executionBudget
          ? `最多 ${durationText(proposal.executionBudget.policy.maxExecutionMs)}`
          : durationText(limits.timeoutMs),
        content: (
          <>
            <DetailFields
              rows={
                proposal.executionBudget
                  ? [
                      [
                        '起始时限',
                        durationText(proposal.executionBudget.initialBudgetMs),
                      ],
                      [
                        '累计上限',
                        durationText(
                          proposal.executionBudget.policy.maxExecutionMs,
                        ),
                      ],
                    ]
                  : [['时限', durationText(limits.timeoutMs)]]
              }
            />
            {proposal.executionBudget && (
              <p>
                准备、安装和运行共用同一个时限；有进展时会自动延长，任务剩余时间不够时会提前停止。
              </p>
            )}
            <TechnicalDetails rows={resourceLimitRows(limits)} />
          </>
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
              : proposal.dependencyResolution
                ? '依赖准备'
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
                {proposal.kind === 'cloud' && proposal.dependencyResolution
                  ? `${proposal.dependencyResolution.packages.length} 个依赖包`
                  : `${
                      proposal.kind === 'project'
                        ? proposal.files.length
                        : proposal.inputs.length
                    } 个输入文件`}
              </span>
              <span className={styles.cloudLocation}>仅在云端执行</span>
              <span>{proposal.network ? '按授权联网' : '不联网'}</span>
            </>
          )}
        </p>
        <div className={styles.cloudControls}>
          <Tooltip label={fullStatus} side="top" align="end">
            <span
              className={styles.status}
              role="status"
              aria-label={cloudOperationCompactStatus(op)}
            >
              {cloudOperationCompactStatus(op)}
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
          <p>{approvalSummary(proposal)}</p>
          {proposal.kind === 'mcp' && (
            <McpApprovalDetails proposal={proposal} />
          )}
          {plannedOutputs}
          <div className={styles.actions}>
            <Button
              className={styles.decision}
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => onAct(op, 'approved')}
            >
              {approveLabel(proposal)}
            </Button>
            <Button
              className={styles.decision}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onAct(op, 'rejected')}
            >
              拒绝
            </Button>
            <small>
              {shortDateTime(request.expiresAt)}{' '}
              前有效。允许后才会开始，结果会显示在这里。
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
        if (!controller.signal.aborted) setLoadError('暂时读不到操作状态');
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
      if (!response.ok) throw Error('operation_decision_unconfirmed');
      if (decision === 'cancel') setCancellationRunId(runId);
      setRevision((value) => value + 1);
    } catch {
      // A network error's own text is English; the outcome is what matters.
      setActionError(
        decision === 'cancel'
          ? '停止请求可能没有送达。请看一下当前状态，再决定是否重新停止。'
          : '你的选择可能没有送达：授权可能已过期、被撤回，或已在别的页面处理。请看一下当前状态，不要重复操作。',
      );
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
      setPendingDecision(null);
    }
  }
  const readFeedback = readUpdated
    ? operations.some((op) => op.snapshot.status === 'unknown')
      ? '已刷新，结果仍待确认。'
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
    <section className={styles.root} aria-label="云端与应用操作">
      {feedback}
      {operations.map((op) =>
        renderOperation(op.snapshot.binding.attempt.operationId),
      )}
    </section>
  );
}
