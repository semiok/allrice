export interface ChatFlowMetricsSnapshot {
  connections: number;
  postgresNotifyConnections: number;
  pollingConnections: number;
  notifyFallbacks: number;
  wakeups: number;
  safetyPolls: number;
  eventsDelivered: number;
  reconnects: number;
}

const metrics: ChatFlowMetricsSnapshot = {
  connections: 0,
  postgresNotifyConnections: 0,
  pollingConnections: 0,
  notifyFallbacks: 0,
  wakeups: 0,
  safetyPolls: 0,
  eventsDelivered: 0,
  reconnects: 0,
};

export function incrementChatFlowMetric(
  key: keyof ChatFlowMetricsSnapshot,
  amount = 1,
) {
  metrics[key] += amount;
}

export function chatFlowMetricsSnapshot(): ChatFlowMetricsSnapshot {
  return { ...metrics };
}
