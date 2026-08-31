export const CONVERSATION_BOTTOM_THRESHOLD_PX = 25;

export interface ConversationScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function conversationDistanceFromBottom(
  metrics: ConversationScrollMetrics,
) {
  return Math.max(
    0,
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight,
  );
}

export function isConversationAtBottom(
  metrics: ConversationScrollMetrics,
  threshold = CONVERSATION_BOTTOM_THRESHOLD_PX,
) {
  return conversationDistanceFromBottom(metrics) <= threshold;
}
