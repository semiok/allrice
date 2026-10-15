import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  UserQuestionItemSchema,
  methodActivationQuestionPrefix,
} from '@allrice/contracts';

// rc.3's ask_user_question consumer drops detail before the native service.
// Restore that presentation field only from this agent's latest Broker receipt.
// This cache grants no approval; persisted question/answer checks remain in DB.
export function preparedMethodQuestions() {
  const entries = new WeakMap();
  return {
    begin(agent) {
      const token = Symbol('method-question');
      entries.set(agent, { token });
      return token;
    },
    complete(agent, token, response) {
      if (entries.get(agent)?.token !== token) return;
      entries.delete(agent);
      try {
        const result = JSON.parse(response.modelContent);
        const question = UserQuestionItemSchema.safeParse(result.question);
        const expiresAt = Date.parse(result.expiresAt);
        if (
          result.enabled === false &&
          z.uuid().safeParse(result.receiptId).success &&
          question.success &&
          question.data.id ===
            methodActivationQuestionPrefix + result.receiptId &&
          expiresAt > Date.now()
        ) {
          entries.set(agent, { question: question.data, expiresAt });
        }
      } catch {
        // A failed preparation cannot revive the previous receipt.
      }
    },
    take(agent, questions) {
      if (
        !questions.some((q) => q.id?.startsWith(methodActivationQuestionPrefix))
      )
        return questions;
      const prepared = entries.get(agent);
      entries.delete(agent);
      const incoming = UserQuestionItemSchema.safeParse(questions[0]);
      if (
        questions.length !== 1 ||
        !prepared?.question ||
        prepared.expiresAt <= Date.now() ||
        !incoming.success
      )
        throw Error('activation_question_invalid');
      const { detail } = prepared.question;
      const completed =
        incoming.data.detail === undefined && detail !== undefined
          ? { ...incoming.data, detail }
          : incoming.data;
      if (!isDeepStrictEqual(completed, prepared.question))
        throw Error('activation_question_invalid');
      return [completed];
    },
    clear(agent) {
      entries.delete(agent);
    },
  };
}
