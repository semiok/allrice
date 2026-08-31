import type { ChatFlowEventEnvelope } from '@allrice/contracts';

/**
 * ChatFlow event history is append-only. Reconnects and durable snapshots may
 * replay events, but they must never replace a richer in-memory timeline with
 * an empty or older snapshot.
 */
export function mergeChatFlowEvents(
  current: ChatFlowEventEnvelope[],
  incoming: ChatFlowEventEnvelope[],
) {
  const events = new Map(
    current.map((event) => [event.eventId, event] as const),
  );
  for (const event of incoming) events.set(event.eventId, event);
  return [...events.values()].sort(
    (left, right) =>
      left.sequence - right.sequence ||
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.eventId.localeCompare(right.eventId),
  );
}
