import {
  UserQuestionRequestSchema,
  type ChatFlowEventEnvelope,
  type UserQuestionItem,
} from '@allrice/contracts';

export interface PendingUserQuestion {
  questionId: string;
  questions: UserQuestionItem[];
  runId: string;
  generation: number;
  turnId: string;
  occurredAt: string;
  sequence: number;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Project the one unanswered DSH question request owned by a live Run. */
export function projectPendingUserQuestion(
  events: ChatFlowEventEnvelope[],
): PendingUserQuestion | null {
  const pending = new Map<string, PendingUserQuestion>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (
      [
        'run.succeeded',
        'run.failed',
        'run.canceled',
        'run.needs_attention',
      ].includes(event.type)
    ) {
      pending.clear();
      continue;
    }
    if (event.type !== 'harness.native' || !event.sourceEvent) continue;
    if (event.sourceEvent.type === 'session/user-question-answered') {
      const answeredId = text(event.sourceEvent.payload.questionId);
      if (answeredId) pending.delete(answeredId);
      continue;
    }
    if (event.sourceEvent.type !== 'session/user-question') continue;
    const request = UserQuestionRequestSchema.safeParse(
      event.sourceEvent.payload,
    );
    const turnId = text(event.payload.turnId);
    const generation = event.generation;
    if (!request.success || !turnId || generation === null) continue;
    pending.set(request.data.questionId, {
      ...request.data,
      runId: event.runId,
      generation,
      turnId,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    });
  }
  return [...pending.values()].at(-1) ?? null;
}
