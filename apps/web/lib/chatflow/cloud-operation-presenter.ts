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
export function cloudOperationCompactLabel(
  op: CloudOperationView,
  now = Date.now(),
) {
  const approval = op.approval;
  if (op.snapshot.status === 'waiting_user') {
    if (approval?.revokedAt) return '已撤回';
    if (approval?.response?.decision === 'rejected') return '你已拒绝';
    if (approval?.response?.decision === 'approved') return '你已允许';
    if (approval && Date.parse(approval.request.expiresAt) <= now)
      return '已过期';
    if (op.proposal.kind === 'mcp' && op.mcpAuthorization?.available !== true)
      return '无法确认权限';
    if (!op.enabled) return '已暂停';
  }
  return cloudOperationStatusLabel(op.snapshot.status);
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
/** A parameter value as a short phrase: never JSON, nested values summarized. */
function valueText(value: unknown, nested = false): string {
  if (value === null || value === undefined || value === '') return '空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value))
    return value.every((item) => item === null || typeof item !== 'object')
      ? value.map((item) => valueText(item)).join('、') || '空'
      : `${value.length} 项`;
  const entries = Object.entries(value);
  if (nested || entries.some(([, item]) => item && typeof item === 'object'))
    return `${entries.length} 个字段`;
  return (
    entries
      .map(([key, item]) => `${key} ${valueText(item, true)}`)
      .join('，') || '空'
  );
}
export const VALUE_LIMIT = 80;
const clip = (text: string, limit = VALUE_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
// Argument names that say who or what the call acts on.
const targets: [RegExp, string][] = [
  [/^(channel|channel_?id|chat_?id|conversation_?id|room)$/i, '渠道'],
  [/^(to|recipients?|receivers?|emails?|cc)$/i, '收件人'],
  [/^(repo|repository|repository_?name)$/i, '仓库'],
  [/^(pull_?number|pull_?request_?number|pr_?number|issue_?number)$/i, '编号'],
  [/^(path|file_?path|file_?name)$/i, '文件'],
];

/** What a pending app call will do, on whom, and with which parameters. */
export function mcpApprovalDetails(proposal: McpProposal) {
  const args = isRecord(proposal.arguments)
    ? proposal.arguments
    : { 内容: proposal.arguments };
  const target = [serviceHost(proposal.endpoint)];
  const ownerRepo =
    typeof args.owner === 'string' && typeof args.repo === 'string';
  if (ownerRepo) target.push(`仓库 ${clip(`${args.owner}/${args.repo}`, 40)}`);
  for (const [key, value] of Object.entries(args)) {
    const label = targets.find(([pattern]) => pattern.test(key))?.[1];
    if (label && !(ownerRepo && key === 'repo'))
      target.push(`${label} ${clip(valueText(value), 40)}`);
  }
  // Only a name is frozen with the call; DSH prefixes it with mcp__<server>__.
  const tool = proposal.tool.startsWith('mcp__')
    ? proposal.tool.split('__').at(-1)!
    : proposal.tool;
  return {
    action: `${tool}（${riskAction(proposal.risk)}）`,
    target: target.join(' · '),
    fields: Object.entries(args).map(([key, value]) => {
      const full = valueText(value);
      return { key, text: clip(full), full };
    }),
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
