import {
  UserQuestionRequestSchema,
  type ChatFlowEventEnvelope,
  type InteractionStatus,
  type UserQuestionAnswerSubmission,
  type UserQuestionRequest,
} from '@allrice/contracts';
import { projectNativeExperience } from './native-experience';
import { currentWorkProgressEvents } from './work-progress';
import { projectPendingUserQuestion } from './user-question-state';

export interface WorkProcessAnswer {
  id: string;
  answer: UserQuestionAnswerSubmission;
  text: string;
  createdAt: string;
  status?: InteractionStatus['inputs'][number]['status'];
}

export interface WorkProcessQuestion {
  request: UserQuestionRequest;
  callId: string;
  pending: boolean;
  answered: boolean;
  answer?: WorkProcessAnswer;
}

/** Presentation-only join. Ambiguous or missing native ownership keeps the
 * answer at its original transcript position; no text/time matching. */
export function workProcessQuestions(
  owners: readonly { id: string; events: ChatFlowEventEnvelope[] }[],
  answers: readonly WorkProcessAnswer[],
) {
  const byOwner = new Map<string, WorkProcessQuestion[]>();
  const ownership = new Map<string, WorkProcessQuestion[]>();
  for (const owner of owners) {
    const events = currentWorkProgressEvents(owner.events);
    const items = projectNativeExperience(events);
    const pending = projectPendingUserQuestion(events);
    const questions = new Map<string, WorkProcessQuestion>();
    for (const event of events) {
      if (event.sourceEvent?.type !== 'session/user-question') continue;
      const parsed = UserQuestionRequestSchema.safeParse(
        event.sourceEvent.payload,
      );
      if (!parsed.success || !parsed.data.durable || !parsed.data.callId)
        continue;
      const request = parsed.data;
      const callId = request.callId!;
      if (
        !items.some(
          (item) =>
            item.id === `tool:${callId}` &&
            item.toolName === 'ask_user_question',
        )
      )
        continue;
      questions.set(request.questionId, {
        request,
        callId,
        pending: pending?.questionId === request.questionId,
        answered: events.some(
          (row) =>
            row.sourceEvent?.type === 'session/user-question-answered' &&
            row.sourceEvent.payload.questionId === request.questionId,
        ),
      });
    }
    byOwner.set(owner.id, [...questions.values()]);
    for (const question of questions.values()) {
      const matches = ownership.get(question.request.questionId) ?? [];
      ownership.set(question.request.questionId, [...matches, question]);
    }
  }
  const embeddedAnswerIds = new Set<string>();
  for (const [id, questions] of ownership) {
    const matches = answers.filter((answer) => answer.answer.questionId === id);
    if (questions.length !== 1 || matches.length !== 1) continue;
    const question = questions[0]!;
    const answer = matches[0]!;
    // Preserve every submitted answer if its question set cannot be identified.
    const ids = question.request.questions.map((item) => item.id);
    if (
      answer.answer.answers.length !== ids.length ||
      new Set(answer.answer.answers.map((item) => item.id)).size !==
        ids.length ||
      answer.answer.answers.some((item) => !ids.includes(item.id))
    )
      continue;
    question.answer = answer;
    embeddedAnswerIds.add(answer.id);
  }
  return { byOwner, embeddedAnswerIds };
}
