import type { BrowserAction, RuntimeOperationStatus } from '@allrice/contracts';

// Plain-language wording for the browser panel shown to ordinary employees.
// Engineering detail (ids, raw actions, receipts) stays in the panel's
// collapsed technical section; nothing here may echo internal codes.

const stateLabels: Record<string, string> = {
  starting: '正在打开浏览器',
  agent: 'Rice 正在使用浏览器',
  takeover_pending: '正在把浏览器交给你',
  human: '由你操作中',
  resume_pending: '正在交还给 Rice',
  pause_pending: '正在暂停',
  paused: '已暂停',
  close_pending: '正在关闭',
  closed: '浏览器已关闭',
  unknown: '结果待确认',
};

export function browserStateLabel(state: string) {
  return stateLabels[state] ?? '状态待确认';
}

/** Whether controls still make sense; a closed browser keeps its history only. */
export function browserControlsVisible(state: string) {
  return state !== 'closed';
}

function siteName(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return '网页';
  }
}

export function browserActionSummary(action: BrowserAction) {
  switch (action.type) {
    case 'observe':
      return '读取当前页面';
    case 'navigate':
      return `打开 ${siteName(action.url)}`;
    case 'click':
      return '点击页面上的按钮或链接';
    case 'fill':
      return '在页面上填写内容';
    case 'sensitive_fill':
      return '安全输入（内容不发给 Rice）';
    case 'upload':
      return `上传文件「${action.fileName}」`;
    case 'download':
      return '下载文件';
    case 'request':
      return `向 ${siteName(action.url)} 提交内容`;
  }
}

const operationStatusLabels: Record<RuntimeOperationStatus, string> = {
  planned: '准备中',
  waiting_user: '等你确认',
  waiting_device: '等待电脑连接',
  waiting_dependency: '准备中',
  ready: '准备中',
  dispatched: '进行中',
  running: '进行中',
  cancel_requested: '正在取消',
  unknown: '结果待确认',
  succeeded: '已完成',
  failed: '未完成',
  canceled: '已取消',
  partial: '部分完成',
};

export function browserOperationStatusLabel(status: RuntimeOperationStatus) {
  return operationStatusLabels[status];
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
