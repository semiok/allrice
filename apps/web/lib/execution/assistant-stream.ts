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

export function assistantStreamText(
  events: AssistantStreamEvent[],
  fallback: string,
) {
  const unique = [
    ...new Map(events.map((event) => [event.eventId, event])).values(),
  ]
    .filter(
      (event) =>
        event.type === 'assistant.text.delta' ||
        event.type === 'assistant.text.completed',
    )
    .sort((left, right) => left.sequence - right.sequence);
  if (!unique.length) return fallback;
  const generation = Math.max(
    ...unique.map((event) => integer(event.payload.generation, 0)),
  );
  const currentGeneration = unique.filter(
    (event) => integer(event.payload.generation, 0) === generation,
  );
  const attempt = Math.max(
    ...currentGeneration.map((event) => integer(event.payload.attempt, 1)),
  );
  const currentAttempt = currentGeneration.filter(
    (event) => integer(event.payload.attempt, 1) === attempt,
  );
  const completed = currentAttempt
    .filter((event) => event.type === 'assistant.text.completed')
    .at(-1);
  if (completed && typeof completed.payload.text === 'string') {
    return completed.payload.text;
  }
  const partial = currentAttempt
    .filter((event) => event.type === 'assistant.text.delta')
    .map((event) =>
      typeof event.payload.text === 'string' ? event.payload.text : '',
    )
    .join('');
  return partial || fallback;
}
