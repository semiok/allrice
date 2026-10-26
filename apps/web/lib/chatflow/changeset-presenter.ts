// Plain-language wording for saving reviewed file changes to the employee's
// computer. Checksums, error codes and run identities stay in the collapsed
// technical details.

const labels: Record<string, string> = {
  pending: '还没开始',
  prepared: '结果待确认',
  applied: '已保存到你的电脑',
  conflict: '文件已被改动，没有覆盖',
  canceled: '已停止，没有处理',
  failed: '未完成',
  unknown: '结果待确认',
  waiting_user: '等你确认',
  ready: '等待电脑连接',
  dispatched: '已发送到电脑',
  running: '正在处理',
  succeeded: '已完成',
  partial: '部分完成',
  cancel_requested: '正在停止',
  queued: '排队中',
};
export const changesetStatusLabel = (status: string) =>
  labels[status] ?? '结果待确认，请刷新查看';

export function changesetTitle(restore: boolean, organization: boolean) {
  return restore ? '恢复文件' : organization ? '整理文件' : '保存修改';
}

export function changesetApproveLabel(restore: boolean, organization: boolean) {
  return restore
    ? '允许恢复这些文件'
    : organization
      ? '允许整理这些文件'
      : '允许保存这些修改';
}

/** What one reviewed file change does. */
export function fileChangeLabel(file: {
  before: unknown | null;
  after: unknown | null;
}) {
  return !file.before ? '新建文件' : !file.after ? '删除文件' : '修改文件';
}
