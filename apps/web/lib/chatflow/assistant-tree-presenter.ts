import type { AssistantTreeView } from '@allrice/database';

const settled = new Set(['completed', 'partial', 'failed', 'canceled']);
export const assistantStateLabel: Readonly<Record<string, string>> = {
  provisioning: '正在准备',
  running: '执行中',
  waiting: '等待中',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancel_requested: '已请求停止 · 待执行端确认',
  canceled: '已取消',
  unknown: '结果待核实',
};
export const assistantMessageLabel: Readonly<Record<string, string>> = {
  pending: '待发送',
  dispatching: '正在交付',
  accepted: '原生端已接收 · 尚未确认落盘',
  durable: '已持久化 · 尚未进入执行上下文',
  adopted: '已进入执行上下文',
  unknown: '交付状态待核实 · 不自动重发',
  canceled: '已取消交付',
};

export function presentAssistantTree(tree: AssistantTreeView) {
  const children = tree.instances.filter((item) => item.parentRunId !== null);
  const unresolved = children.filter(
    (item) =>
      !settled.has(item.status) ||
      (item.cancelRequestedAt !== null && item.stoppedAt === null),
  );
  const attention = children.filter((item) =>
    ['unknown', 'failed', 'partial', 'waiting'].includes(item.status),
  );
  const unconfirmedStops = tree.instances.filter(
    (item) => item.cancelRequestedAt && !item.stoppedAt,
  );
  const hasLiveWork =
    tree.instances.some((item) => !settled.has(item.status)) ||
    unconfirmedStops.length > 0;
  return {
    children,
    unresolved,
    attention,
    unconfirmedStops,
    hasLiveWork,
    label: children.length
      ? `Rice 已安排 ${children.length} 个助手`
      : '日常任务 · 暂无助手',
    summary: tree.cancelRequested
      ? unconfirmedStops.length
        ? `已请求取消整项任务，${unconfirmedStops.length} 项尚未确认停止`
        : '整项任务已收到取消请求'
      : attention.length
        ? `${attention.length} 个助手需要关注`
        : unresolved.length
          ? `${unresolved.length} 个助手仍在处理`
          : children.length
            ? '助手执行已结束，结果采用状态见明细'
            : tree.configuration.allowAssistants
              ? '可按需要进行有限委派'
              : '由 Rice 独立处理',
  };
}
