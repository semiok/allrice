import type { CloudOperationView } from '@allrice/database';
import { fileSizeText } from '@deepseek-ai/dsh-client-ui-primitives';
import type { McpFailureKind } from '@allrice/contracts';

// Plain-language wording for cloud and app operations shown to ordinary
// employees. Raw JSON, digests, file IDs and return codes stay in the
// collapsed technical details. A pending app call is the exception: its
// action, target and parameters are what the employee decides on.

type Proposal = CloudOperationView['proposal'];
type McpProposal = Extract<Proposal, { kind: 'mcp' }>;
type Limits = Exclude<Proposal, { kind: 'mcp' }>['limits'];

const statusLabels: Record<CloudOperationView['snapshot']['status'], string> = {
  planned: '准备中',
  waiting_user: '等你确认',
  waiting_device: '准备中',
  waiting_dependency: '准备中',
  ready: '准备中',
  dispatched: '进行中',
  running: '进行中',
  cancel_requested: '正在停止',
  unknown: '结果待确认',
  succeeded: '已完成',
  failed: '未完成',
  canceled: '已取消',
  partial: '部分完成',
};
export function cloudOperationStatusLabel(status: string) {
  return (statusLabels as Record<string, string>)[status] ?? '结果待确认';
}

/** A waiting step that can no longer be answered says why. */
/**
 * Whether a step waiting on approval can still go on, as a short word and a
 * full sentence from one decision. The employee's earlier answer is history;
 * what counts is what admission would check now: until the Worker consumes an
 * approval, the server still rejects it once expired, revoked, paused or no
 * longer authorized (runtime-policy.ts). Null when the step is not waiting.
 */
export function approvalState(op: CloudOperationView, now = Date.now()) {
  if (op.snapshot.status !== 'waiting_user') return null;
  const approval = op.approval;
  const allowed = approval?.response?.decision === 'approved';
  const blocked = (short: string, reason: string) => ({
    short,
    full: allowed ? `你已允许，但${reason}` : reason,
  });
  if (approval?.revokedAt) return blocked('已撤回', '授权已撤回，没有执行');
  if (approval?.response?.decision === 'rejected')
    return { short: '你已拒绝', full: '你已拒绝，没有执行' };
  if (allowed && approval?.consumedAt)
    return { short: '你已允许', full: '你已允许，正在准备' };
  if (approval && Date.parse(approval.request.expiresAt) <= now)
    return blocked(
      '已过期',
      allowed ? '开始前授权已过期，没有执行' : '已过期，没有执行',
    );
  if (op.proposal.kind === 'mcp' && op.mcpAuthorization?.available !== true)
    return blocked(
      '无法确认权限',
      `${mcpAuthorizationLabel(op.mcpAuthorization?.reason)}，不能执行这一步`,
    );
  if (!op.enabled) return blocked('已暂停', '这类操作已暂停使用，暂时不能执行');
  if (allowed) return { short: '你已允许', full: '你已允许，正在准备' };
  return { short: '等你确认', full: '等你确认' };
}

/** A waiting step that can no longer be answered says why. */
export function cloudOperationCompactLabel(
  op: CloudOperationView,
  now = Date.now(),
) {
  return (
    approvalState(op, now)?.short ??
    cloudOperationStatusLabel(op.snapshot.status)
  );
}

// What happened to an app call and what to do next. The shared contract copy
// names HTTP codes and asks people to 核实; these words are for employees.
const mcpFailures: Record<McpFailureKind, [title: string, detail: string]> = {
  github_merge_permission: [
    'GitHub 权限不足',
    '这次合并被 GitHub 拒绝：使用的访问令牌没有这个仓库的写入权限。请让管理员给令牌加上这个仓库的 Contents 读写权限，再让 AI 员工重新发起；这次不会自动重试。',
  ],
  authentication: [
    '应用授权需要更新',
    '这个应用的登录授权不可用了。请到「设置 → 已链接应用」更新授权，再让 AI 员工重新发起。',
  ],
  remote_error: [
    '应用返回错误',
    '应用回复了错误，这一步可能没有做完，也可能只做了一部分。请先到应用里看一下结果，再决定下一步；这次不会自动重试。',
  ],
  unavailable: [
    '应用连接暂时不可用',
    '连接应用时出了问题，这一步没有发出。请稍后让 AI 员工重新发起。',
  ],
  result_unknown: [
    '结果待确认',
    '没有收到应用的完整结果，不确定这一步有没有生效。请先到应用里看一下；这次不会自动重试。',
  ],
};
export function mcpFailureNotice(kind: McpFailureKind) {
  const [title, detail] = mcpFailures[kind];
  return { title, detail };
}

export function mcpAuthorizationLabel(reason: string | undefined) {
  switch (reason) {
    case 'connection_revoked':
      return '应用连接已断开';
    case 'connection_or_tool_changed':
      return '应用连接或权限有变化';
    case 'employee_authorization_changed':
      return 'AI 员工的应用权限有变化';
    default:
      return '暂时无法确认应用权限';
  }
}

const risks: Record<string, [label: string, action: string]> = {
  read: ['读取', '读取数据'],
  read_only: ['读取', '读取数据'],
  external_send: ['对外发送', '对外发送内容'],
  high_risk_data: ['敏感数据', '处理敏感数据'],
  write: ['写入', '写入数据'],
  destructive: ['删除或改动', '删除或改动数据'],
};
export const mcpRiskLabel = (risk: string) => risks[risk]?.[0] ?? '其他操作';
const riskAction = (risk: string) => risks[risk]?.[1] ?? '完成这次操作';

/** An app's address as people read it: its host name only. */
export function serviceHost(endpoint: string) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '第三方应用';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const scalarText = (value: unknown) =>
  value === null || value === undefined
    ? '（空）'
    : value === ''
      ? '（空文字）'
      : typeof value === 'boolean'
        ? value
          ? '是'
          : '否'
        : String(value);
export const VALUE_LIMIT = 80;
const LINE_LIMIT = 4;
/** A long value cut to its first lines and characters; newlines stay. */
function clip(text: string, limit = VALUE_LIMIT) {
  const lines = text.split('\n');
  const head = lines.slice(0, LINE_LIMIT).join('\n');
  if (head.length <= limit && lines.length <= LINE_LIMIT) return text;
  return `${head.slice(0, limit - 1)}…`;
}
export type ApprovalField = { path: string; text: string; full: string };
/** Every leaf value with its path: 「recipients 第 1 项 · email」. */
function collect(value: unknown, path: string[], out: ApprovalField[]) {
  if (Array.isArray(value)) {
    if (!value.length) out.push(leaf(path, '（空列表）'));
    value.forEach((item, index) => {
      const at = [...path];
      const position = `第 ${index + 1} 项`;
      if (at.length) at[at.length - 1] = `${at.at(-1)} ${position}`;
      else at.push(position);
      collect(item, at, out);
    });
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (!entries.length) out.push(leaf(path, '（空）'));
    for (const [key, item] of entries) collect(item, [...path, key], out);
  } else out.push(leaf(path, scalarText(value)));
}
const leaf = (path: string[], full: string): ApprovalField => ({
  path: path.join(' · ') || '内容',
  text: clip(full),
  full,
});
export const FIELD_LIMIT = 50;
// Argument names that say who or what the call acts on.
const targetNames: [RegExp, string][] = [
  [/^(channel|channel_?id|chat_?id|conversation_?id|room)$/i, '渠道'],
  [/^(to|recipients?|receivers?|emails?|cc)$/i, '收件人'],
  [/^(repo|repository|repository_?name)$/i, '仓库'],
  [/^(pull_?number|pull_?request_?number|pr_?number|issue_?number)$/i, '编号'],
  [/^(path|file_?path|file_?name)$/i, '文件'],
];

const identityNames = /^(email|address|id|login|name|user_?name|handle)$/i;

/** What a pending app call will do, on whom, and with which parameters. */
export function mcpApprovalDetails(proposal: McpProposal) {
  const all: ApprovalField[] = [];
  collect(proposal.arguments, [], all);
  const args = isRecord(proposal.arguments) ? proposal.arguments : {};
  const targets: { label: string; value: string }[] = [];
  const ownerRepo =
    typeof args.owner === 'string' && typeof args.repo === 'string';
  if (ownerRepo)
    targets.push({
      label: '仓库',
      value: clip(`${args.owner}/${args.repo}`, 40),
    });
  for (const field of all) {
    // r1-exempt(display): 去掉 collect() 给数组参数拼的“第 N 项”后缀来认出目标参数名；参数名来自工具调用，只影响审批卡上标哪些参数为目标
    const keys = field.path
      .split(' · ')
      .map((key) => key.replace(/ 第 \d+ 项$/, ''));
    if (ownerRepo && keys[0] === 'repo') continue;
    // The value of a target name itself, or an identity field inside it
    // (recipients 第 1 项 · email), not every value nested under it.
    const named = (key: string) =>
      targetNames.find(([pattern]) => pattern.test(key))?.[1];
    const last = keys.at(-1) ?? '';
    const label =
      named(last) ??
      (identityNames.test(last) ? keys.map(named).find(Boolean) : undefined);
    const value = clip(field.full.replace(/\s+/g, ' '), 40);
    if (label && !targets.some((t) => t.label === label && t.value === value))
      targets.push({ label, value });
  }
  return {
    // DSH names a connected app's tool mcp__app__<tool> (native-transport.ts);
    // only that exact prefix goes, the tool's own name stays whole.
    action: `${proposal.tool.replace(/^mcp__app__/, '')}（${riskAction(proposal.risk)}）`,
    host: serviceHost(proposal.endpoint),
    targets: targets.slice(0, 4),
    moreTargets: Math.max(0, targets.length - 4),
    fields: all.slice(0, FIELD_LIMIT),
    moreFields: Math.max(0, all.length - FIELD_LIMIT),
  };
}

/** The approve button names what is being allowed. */
export function approveLabel(proposal: Proposal) {
  if (proposal.kind === 'mcp') return `允许${riskAction(proposal.risk)}`;
  if (proposal.kind === 'project') return '允许运行项目';
  return proposal.dependencyResolution ? '允许准备依赖包' : '允许运行脚本';
}

/** What happens after approval, shown beside the approve button. */
export function approvalSummary(proposal: Proposal) {
  if (proposal.kind === 'mcp')
    return `允许后，会按下面的内容调用 ${serviceHost(proposal.endpoint)}。这个应用在 AllRice 之外运行，可能读取或修改你在其中的数据。只允许这一次。`;
  const network = proposal.network ? '可以访问上面列出的网站' : '不联网';
  if (proposal.kind === 'project')
    return `允许后，会在云端运行你保存的项目副本，${network}，不会访问你的电脑。`;
  if (proposal.dependencyResolution)
    return '允许后，会联网查询这些依赖包的可用版本，不读取也不发送你的文件。';
  return `允许后，会在云端运行这段脚本，${proposal.inputs.length ? `只读取你提供的 ${proposal.inputs.length} 个文件` : '不读取你的文件'}，${network}，不会访问你的电脑。`;
}

/** A stop request or a lost result: what may have happened and what to do. */
export function unconfirmedNote(proposal: Proposal, status: string) {
  const head =
    status === 'cancel_requested'
      ? '已经发出停止请求，云端可能还要一会儿才会停下。'
      : '没有收到完整的结果，不确定这一步有没有生效。';
  if (proposal.kind === 'mcp')
    return `${head}这个应用可能已经有了改动，请先到应用里看一下；不会自动重新执行。`;
  if (proposal.network)
    return `${head}已经发出的网络请求可能已经生效，请先到相关网站看一下；不会自动重新执行。`;
  return `${head}请稍后刷新查看结果；不会自动重新执行。`;
}

/** Next step for a finished step that did not fully work. */
export function resultNote(status: string) {
  if (status === 'failed')
    return '这一步未完成。可以在对话里让 AI 员工换个方式再试；需要排查时，可以展开「技术详情」查看原始记录。';
  if (status === 'partial') return '只完成了一部分，请查看生成的文件确认结果。';
  return null;
}

/** 「30 秒」「2 分钟」「1 分 30 秒」. */
export function durationText(ms: number) {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (!minutes) return `${seconds} 秒`;
  return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
}

/** Resource ceilings in units people read, for the technical details. */
export function resourceLimitRows(limits: Limits): [string, string][] {
  return [
    ['算力', `${limits.cpuMillis / 1000} 核 CPU、${limits.memoryMiB} MB 内存`],
    ['进程数上限', `${limits.pids} 个`],
    ['输出上限', fileSizeText(limits.outputBytes)],
    ...('artifactBytes' in limits
      ? [['成果上限', fileSizeText(limits.artifactBytes)] as [string, string]]
      : []),
  ];
}
