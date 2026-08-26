import type { HarnessEvent, RunEventType } from '@allrice/contracts';

export interface NormalizedHarnessRunEvent {
  type: RunEventType;
  payload: Record<string, unknown>;
}

/** Translate an adapter event into the durable, harness-neutral AllRice event. */
export function normalizeHarnessRunEvent(
  event: HarnessEvent,
): NormalizedHarnessRunEvent {
  const envelope = {
    source: event.harness,
    generation: event.generation,
    threadId: event.threadId,
    turnId: event.turnId,
    conversationId: event.sessionId,
    messageId: event.messageId,
    attempt: event.attempt,
    order: event.order,
    ...(event.sourceEventId ? { sourceEventId: event.sourceEventId } : {}),
    ...(event.sourceEventType
      ? { sourceEventType: event.sourceEventType }
      : {}),
    ...(event.sourceOccurredAt
      ? { sourceOccurredAt: event.sourceOccurredAt }
      : {}),
    ...(event.sourcePayload ? { nativePayload: event.sourcePayload } : {}),
  };
  if (event.type === 'assistant.completed') {
    return {
      type: 'assistant.text.completed',
      payload: { ...envelope, text: event.text },
    };
  }
  if (event.type === 'assistant.delta') {
    return {
      type: 'assistant.text.delta',
      payload: {
        ...envelope,
        text: event.text,
        ...(event.orderStart ? { orderStart: event.orderStart } : {}),
      },
    };
  }
  if (event.type === 'usage.updated') {
    return {
      type: 'usage.updated',
      payload: {
        ...envelope,
        usage: {
          inputTokens: event.inputTokens,
          cachedInputTokens: event.cachedInputTokens,
          outputTokens: event.outputTokens,
        },
      },
    };
  }
  const status = event.type.split('.')[1] as 'started' | 'completed' | 'failed';
  return {
    type: event.type,
    payload: {
      ...envelope,
      source: event.source === 'tool_broker' ? 'tool_broker' : event.harness,
      toolCallId: event.toolCallId,
      name: event.name,
      label: event.label,
      status,
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.itemCount === undefined ? {} : { itemCount: event.itemCount }),
    },
  };
}
