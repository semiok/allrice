import { matchUserQuestionAnswer } from '@allrice/contracts/native-runtime';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const userQuestionAnswerPrefix = 'allrice:user-question:v1:';

/** Decode a structured AllRice answer and check it against the live DSH wait
 * with the one shared rule (contracts matchUserQuestionAnswer, MET-210). */
export function structuredUserQuestionAnswer(pending, text) {
  if (!text.startsWith(userQuestionAnswerPrefix)) return null;
  let submission;
  try {
    submission = JSON.parse(text.slice(userQuestionAnswerPrefix.length));
  } catch {
    throw new TypeError('structured user question answer is invalid JSON');
  }
  const answer = matchUserQuestionAnswer(pending, submission);
  if (!answer)
    throw new TypeError(
      'structured user question answer does not match the pending request',
    );
  return answer;
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
