/**
 * What a failed API request means for an ordinary employee, and what to do.
 * Order: Chinese copy the server wrote for people, then the error code, then
 * the HTTP status. Status codes and English API messages never reach the screen.
 */

// Codes that several failures share are told apart by the fixed English
// message of `lib/bridge/responses.ts` and `lib/storage/responses.ts`.
const byServerMessage: Readonly<Record<string, string>> = {
  'Bridge device is offline': '电脑未连接，请打开 AllRice 电脑端后再试',
  'Bridge command is unavailable':
    '电脑端暂时做不了这一步。请确认 AllRice 电脑端已打开并更新到最新版本、文件夹已授权，再试一次',
  'Bridge command result is too large': '电脑上的文件太大，请换小一点的文件',
  'Pairing code is invalid, expired, or already used':
    '配对码无效或已过期，请重新生成配对码',
  'Workspace storage quota exceeded':
    '空间已用完，请删除不用的文件或联系管理员',
};

const byCode: Readonly<Record<string, string>> = {
  ORIGIN_DENIED: '请刷新页面后再试',
  SIGNED_ACCESS_DENIED: '链接无效或已失效，请刷新页面后再试',
  KNOWLEDGE_ACL_DENIED: '没有权限查看这份资料，如需使用请联系管理员',
  CURSOR_INVALID: '内容已更新，请刷新页面后再试',
  CURSOR_EXPIRED: '内容已更新，请刷新页面后再试',
  APPROVAL_REQUIRED: '这一步需要你先确认，请在对话里查看',
  WORKFLOW_NEEDS_ATTENTION: '工作流需要你处理，请在对话里查看',
  QUOTA_EXCEEDED: '已超出可用额度，请删除不用的内容或联系管理员',
};

const byStatus: Readonly<Record<number, string>> = {
  401: '登录已过期，请重新登录',
  403: '没有权限，如需使用请联系管理员',
  404: '内容不存在或已删除',
  409: '内容已被修改，请刷新后再试',
  413: '内容太大，请减少内容或换小一点的文件',
  429: '操作太频繁，请稍后再试',
};

export const requestNotFinished =
  '这次操作未完成。请刷新页面后重新操作；仍不行请联系管理员。';

export function requestFailureMessage(failure: {
  status: number;
  code?: unknown;
  message?: unknown;
}) {
  const { status, code, message } = failure;
  if (typeof message === 'string') {
    if (/[\u3400-\u9fff]/.test(message)) return message;
    if (Object.hasOwn(byServerMessage, message))
      return byServerMessage[message]!;
  }
  if (typeof code === 'string' && Object.hasOwn(byCode, code))
    return byCode[code]!;
  return (
    byStatus[status] ??
    (status >= 500 ? '服务暂时不可用，请稍后刷新页面再试' : requestNotFinished)
  );
}
