import type { BrowserWorkspaceView } from '@allrice/database';
import {
  localPreviewSuffix,
  type BrowserAction,
  type BrowserObservation,
  type RuntimeOperationStatus,
} from '@allrice/contracts';

// Plain-language wording for the browser panel shown to ordinary employees.
// Engineering detail (ids, raw actions, receipts) stays in the panel's
// collapsed technical section; nothing here may echo internal codes.

type Operation = BrowserWorkspaceView['operations'][number];

/** An employee name inside Chinese text: Latin names get spaces, as in 「与 Rice 工作」. */
export function employeeInText(employee: string) {
  return `${/^[A-Za-z0-9]/.test(employee) ? ' ' : ''}${employee}${/[A-Za-z0-9]$/.test(employee) ? ' ' : ''}`;
}

export function browserStateLabel(state: string, employee: string) {
  const labels: Record<string, string> = {
    starting: '正在打开浏览器',
    agent: `${employeeInText(employee).trimStart()}正在使用浏览器`,
    takeover_pending: '正在把浏览器交给你',
    human: '由你操作中',
    resume_pending: `正在交还给${employeeInText(employee).trimEnd()}`,
    pause_pending: '正在暂停',
    paused: '已暂停',
    close_pending: '正在关闭',
    closed: '浏览器已关闭',
    unknown: '结果待确认，请刷新状态查看',
  };
  return labels[state] ?? '状态待确认，请刷新状态查看';
}

/** Whether controls still make sense; a closed browser keeps its history only. */
export function browserControlsVisible(state: string) {
  return state !== 'closed';
}

/** A page address as people read it; previews never show their internal host. */
export function siteLabel(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.host.endsWith(localPreviewSuffix)) return '你的项目预览';
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const label = `${parsed.host}${path}`;
    return label.length > 60 ? `${label.slice(0, 59)}…` : label;
  } catch {
    return '网页';
  }
}

const elementWords: Record<string, string> = {
  a: '链接',
  button: '按钮',
  input: '输入框',
  textarea: '文本框',
  select: '下拉选择',
};
export const elementLabel = (element: { label: string; tag: string }) =>
  element.label || elementWords[element.tag] || '页面元素';

function quoted(value: string) {
  return value.length > 40 ? `「${value.slice(0, 39)}…」` : `「${value}」`;
}

/** What one step does, naming the page element when its observation is current. */
export function browserActionSummary(
  action: BrowserAction,
  employee: string,
  elements: BrowserObservation['elements'] = [],
) {
  const target =
    'elementId' in action
      ? elements.find((element) => element.id === action.elementId)
      : undefined;
  const element = target
    ? `「${elementLabel(target)}」${target.label ? (elementWords[target.tag] ?? '') : ''}`
    : '';
  switch (action.type) {
    case 'observe':
      return '读取当前页面';
    case 'navigate':
      return `打开 ${siteLabel(action.url)}`;
    case 'click':
      return element ? `点击${element}` : '点击页面上的按钮或链接';
    case 'fill':
      return `${element ? `在${element}` : '在页面上'}填写${quoted(action.value)}`;
    case 'sensitive_fill':
      return `${element ? `在${element}` : '在页面上'}安全输入（内容不发给${employeeInText(employee).trimEnd()}）`;
    case 'upload':
      return `上传文件「${action.fileName}」`;
    case 'download':
      return element ? `下载${element}` : '下载文件';
    case 'request':
      return action.method === 'DELETE'
        ? `删除 ${siteLabel(action.url)} 上的内容`
        : action.method === 'POST'
          ? `向 ${siteLabel(action.url)} 提交内容`
          : `修改 ${siteLabel(action.url)} 上的内容`;
    default:
      return '浏览器操作';
  }
}

const statusLabels = (
  employee: string,
): Record<RuntimeOperationStatus, string> => ({
  planned: '准备中',
  waiting_user: '等你确认',
  waiting_device: '等待电脑连接',
  waiting_dependency: '准备中',
  ready: '准备中',
  dispatched: '进行中',
  running: '进行中',
  cancel_requested: '正在取消',
  unknown: '结果待确认，请刷新状态查看',
  succeeded: '已完成',
  failed: `未完成，可以让${employeeInText(employee)}再试一次`,
  canceled: '已取消',
  partial: '部分完成，请查看页面确认',
});

/** A step's state, folding in the approval answer and whether it is still valid. */
export function browserOperationStatusLabel(
  op: Operation,
  employee: string,
  now = Date.now(),
) {
  const approval = op.approval;
  if (approval?.response?.decision === 'rejected') return '你已拒绝，没有执行';
  if (op.snapshot.status === 'waiting_user') {
    if (approval?.revokedAt) return '已撤回，没有执行';
    if (approval && Date.parse(approval.request.expiresAt) <= now)
      return '已过期，没有执行';
    if (!op.available) return '已失效，没有执行';
  }
  return (
    statusLabels(employee)[op.snapshot.status] ?? '状态待确认，请刷新状态查看'
  );
}

/** Message for a failed approval answer; the identical answer may be resent. */
export function approvalErrorMessage(code: unknown, employee: string) {
  const messages: Record<string, string> = {
    approval_not_found: '这一步已经不在了，请刷新状态查看。',
    approval_not_pending: '这一步已经处理过了，请刷新状态查看。',
    // The server checks validity before an earlier identical answer, so a
    // stale answer may still have run: never claim it did not.
    approval_invalid_or_stale: `这一步的授权已失效。请刷新状态，看这一步有没有完成，再决定是否让${employeeInText(employee)}重新发起。`,
    approval_response_mismatch:
      '这一步的答复没有被接受，可能已经过期。请刷新状态查看。',
    approval_response_conflict: '这一步已经有了别的答复，请刷新状态查看。',
    policy_denied: '公司的安全设置不允许这一步，没有执行。',
    ORIGIN_DENIED: '请刷新页面后再试。',
  };
  return (
    (typeof code === 'string' && messages[code]) ||
    '答复可能没有送达。可以再点一次，不会重复执行。'
  );
}

/** 「11 月 1 日 09:00」; the year is shown only when it is not this year. */
export function shortDateTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getFullYear() === now.getFullYear()
    ? day
    : `${date.getFullYear()} 年 ${day}`;
}
