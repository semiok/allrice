import { createUserMessage } from '@deepseek-ai/dsh-llm';

const userQuestionAnswerPrefix = 'allrice:user-question:v1:';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/** Decode and validate a structured AllRice answer against the live DSH wait. */
export function structuredUserQuestionAnswer(pending, text) {
  if (!text.startsWith(userQuestionAnswerPrefix)) return null;
  let submission;
  try {
    submission = JSON.parse(text.slice(userQuestionAnswerPrefix.length));
  } catch {
    throw new TypeError('structured user question answer is invalid JSON');
  }
  const payload = record(submission);
  if (
    payload?.questionId !== pending.questionId ||
    !Array.isArray(payload.answers) ||
    payload.answers.length !== pending.questions.length
  ) {
    throw new TypeError(
      'structured user question answer does not match the pending request',
    );
  }
  const byId = new Map();
  for (const answerValue of payload.answers) {
    const answer = record(answerValue);
    if (
      typeof answer?.id !== 'string' ||
      byId.has(answer.id) ||
      !Array.isArray(answer.selected) ||
      answer.selected.some((label) => typeof label !== 'string') ||
      (answer.custom !== undefined && typeof answer.custom !== 'string')
    ) {
      throw new TypeError(
        'structured user question answer has an invalid item',
      );
    }
    byId.set(answer.id, answer);
  }
  return {
    answers: pending.questions.map((question) => {
      const answer = byId.get(question.id);
      if (!answer) {
        throw new TypeError('structured user question answer is incomplete');
      }
      const labels = new Set(
        (question.options ?? []).map((option) => option.label),
      );
      if (answer.selected.some((label) => !labels.has(label))) {
        throw new TypeError(
          'structured user question answer selected an unknown option',
        );
      }
      if (question.multiSelect !== true && answer.selected.length > 1) {
        throw new TypeError(
          'structured user question answer selected too many options',
        );
      }
      const custom = answer.custom?.trim();
      if (
        question.multiSelect !== true &&
        custom &&
        answer.selected.length > 0
      ) {
        throw new TypeError(
          'a custom single-choice answer cannot also select an option',
        );
      }
      return {
        id: question.id,
        selected: [...answer.selected],
        ...(custom ? { custom } : {}),
      };
    }),
  };
}

/**
 * Translate one AllRice steer string into the immutable upstream user message
 * and submit it to the live DSH agent.
 */
export function steerDshAgent(agent, text) {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  agent.steer(message);
  return message.id;
}
