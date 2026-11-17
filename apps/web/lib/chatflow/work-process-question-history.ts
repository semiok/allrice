import {
  UserQuestionRequestSchema,
  type ChatFlowEventEnvelope,
  type UserQuestionRequest,
} from '@allrice/contracts';
import { projectNativeExperience } from './native-experience';

/** Read native answer authority, never a tool's successful return alone. */
export function workProcessQuestionAnswered(
  request: UserQuestionRequest,
  event: ChatFlowEventEnvelope,
) {
  const source = event.sourceEvent;
  if (source?.type === 'session/user-question-answered')
    return source.payload.questionId === request.questionId;
  if (
    source?.type !== 'session/user-questions' ||
    !request.durable ||
    !request.nativeSessionId ||
    !request.callId
  )
    return false;
  const { sessionId, questions } = source.payload;
  return (
    sessionId === request.nativeSessionId &&
    !!questions &&
    typeof questions === 'object' &&
    'settled' in questions &&
    Array.isArray(questions.settled) &&
    questions.settled.some(
      (settled: unknown) =>
        !!settled &&
        typeof settled === 'object' &&
        'callId' in settled &&
        settled.callId === request.callId,
    )
  );
}

/** Only answered question receipts may survive an execution attempt change.
 * The current body, activity and every other tool retain their original filter.
 */
export function workProcessQuestionHistory(
  events: ChatFlowEventEnvelope[],
  current: ChatFlowEventEnvelope[],
) {
  const scope = (event: ChatFlowEventEnvelope) =>
    JSON.stringify([
      event.organizationId,
      event.workspaceId,
      event.conversationId,
      event.runId,
      event.payload.generation ?? event.generation ?? 0,
    ]);
  const scopes = new Set(current.map(scope));
  const history: ChatFlowEventEnvelope[] = [];
  const blocked = new Set<string>();
  if (scopes.size !== 1) return { history, blocked };
  const all = [
    ...new Map(events.map((event) => [event.eventId, event])).values(),
  ]
    .filter((event) => scopes.has(scope(event)))
    .sort((a, b) => a.sequence - b.sequence);
  const requests = all.flatMap((event) => {
    if (event.sourceEvent?.type !== 'session/user-question') return [];
    const parsed = UserQuestionRequestSchema.safeParse(
      event.sourceEvent.payload,
    );
    return parsed.success && parsed.data.nativeSessionId && parsed.data.callId
      ? [{ event, request: parsed.data }]
      : [];
  });
  for (const { event, request } of requests) {
    const peers = requests.filter(
      (other) =>
        other.request.questionId === request.questionId ||
        other.request.callId === request.callId,
    );
    const calls = all.filter(
      (row) =>
        (row.type.startsWith('tool.') ||
          (row.type === 'harness.native' &&
            ['tool', 'search'].includes(String(row.payload.presentation)))) &&
        (row.payload.toolCallId ?? row.sourceEvent?.payload.callId) ===
          request.callId,
    );
    const starts = calls.filter(
      (row) => row.type === 'tool.started' || row.payload.status === 'started',
    );
    const names = calls.map(
      (row) => row.payload.name ?? row.sourceEvent?.payload.name,
    );
    if (
      new Set(peers.map((peer) => JSON.stringify(peer.request))).size !== 1 ||
      new Set(starts.map((row) => row.sourceEvent?.id ?? row.eventId)).size >
        1 ||
      names.some(
        (name) => typeof name === 'string' && name !== 'ask_user_question',
      )
    ) {
      blocked.add(request.questionId);
      continue;
    }
    const answered = all.filter(
      (row) =>
        workProcessQuestionAnswered(request, row) &&
        row.sequence > event.sequence,
    );
    if (
      !answered.length ||
      (!request.durable &&
        !projectNativeExperience(calls).some(
          (item) => item.toolName === 'ask_user_question',
        ))
    )
      continue;
    history.push(event, ...calls, ...answered);
  }
  const currentIds = new Set(current.map((event) => event.eventId));
  return {
    history: [
      ...new Map(history.map((event) => [event.eventId, event])).values(),
    ]
      .filter((event) => !currentIds.has(event.eventId))
      .sort((a, b) => a.sequence - b.sequence),
    blocked,
  };
}
