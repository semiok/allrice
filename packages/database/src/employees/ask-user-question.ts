import type { UserQuestionItem } from '@allrice/contracts';

/** A server-rendered question in the native ask_user_question argument shape.
 * The model passes it through unchanged; it never becomes authority itself. */
export function askUserQuestionArguments(question: UserQuestionItem) {
  const { multiSelect, ...item } = question;
  return { questions: [{ ...item, multi_select: multiSelect }] };
}
