export interface AssistantStreamEvent {
  eventId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

function integer(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : fallback;
}

/** Ignore replay duplicates and superseded execution attempts. */
export function currentAssistantEvents<T extends AssistantStreamEvent>(
  events: T[],
): T[] {
  const unique = [
    ...new Map(events.map((event) => [event.eventId, event])).values(),
  ].sort((a, b) => a.sequence - b.sequence);
  const generation = Math.max(
    0,
    ...unique.map((event) => integer(event.payload.generation, 0)),
  );
  const current = unique.filter(
    (event) => integer(event.payload.generation, 0) === generation,
  );
  const attempt = Math.max(
    1,
    ...current.map((event) => integer(event.payload.attempt, 1)),
  );
  return current.filter(
    (event) => integer(event.payload.attempt, 1) === attempt,
  );
}

export function assistantReplies(events: AssistantStreamEvent[]) {
  const replies = new Map<
    string,
    { id: string; sequence: number; text: string }
  >();
  for (const event of currentAssistantEvents(events)) {
    if (event.type !== 'assistant.text.delta') continue;
    const id =
      typeof event.payload.replyId === 'string'
        ? event.payload.replyId
        : 'legacy';
    const previous = replies.get(id);
    const text =
      typeof event.payload.text === 'string' ? event.payload.text : '';
    replies.set(id, {
      id,
      sequence: previous?.sequence ?? event.sequence,
      text:
        event.payload.textMode === 'replace'
          ? text
          : (previous?.text ?? '') + text,
    });
  }
  return [...replies.values()].filter((reply) => reply.text.trim());
}

export function assistantStreamText(
  events: AssistantStreamEvent[],
  fallback: string,
) {
  const current = currentAssistantEvents(events);
  const completed = current
    .filter((event) => event.type === 'assistant.text.completed')
    .at(-1);
  if (completed && typeof completed.payload.text === 'string')
    return completed.payload.text;
  return (
    assistantReplies(current)
      .map((reply) => reply.text)
      .join('\n\n') || fallback
  );
}
