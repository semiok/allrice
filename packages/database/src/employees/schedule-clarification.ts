import {
  UserQuestionRequestSchema,
  UserQuestionAnswerSubmissionSchema,
} from '@allrice/contracts';
import { explicitOnceTaskIntent } from './once-task-intent.ts';
import { explicitRecurringTaskIntent } from './recurring-task-intent.ts';
import { scheduleConversationIntent } from './schedule-conversation-intent.ts';

const number = '[0-9零〇一二两三四五六七八九十百千万]+';
const prefix = '(?:请\\s*|麻烦(?:你)?\\s*)?(?:(?:帮我|为我)\\s*)?';
const timedWork = new RegExp(
  `^${prefix}(?:每(?:隔)?\\s*)?(${number})\\s*(分钟|小时|天)(?:之后|以后|后)?\\s*[，,:：]?\\s*(.+?)[。！!]*$`,
  'su',
);
const frequency = new RegExp(
  `^${prefix}(每(?:隔)?\\s*)?(${number})\\s*(分钟|小时|天)(之后|以后|后)?\\s*(?:提醒(?:我|我们)?(?:一次|一下)?|(?:循环|重复)(?:提醒)?)?[。！!]*$`,
  'u',
);

/** Only an authenticated answer can disambiguate a shorthand timed request.
 * Question descriptions and model-generated work never become authority. The
 * original work must pass the existing instruction checks; the chosen label
 * supplies the frequency, not a replacement task. */
export function clarifiedScheduleIntent(
  request: string,
  rawQuestion: unknown,
  rawAnswer: unknown,
) {
  const question = UserQuestionRequestSchema.safeParse(rawQuestion);
  const answer = UserQuestionAnswerSubmissionSchema.safeParse(rawAnswer);
  if (
    !question.success ||
    !answer.success ||
    answer.data.questionId !== question.data.questionId ||
    question.data.questions.length !== 1 ||
    answer.data.answers.length !== 1
  )
    return null;
  const item = question.data.questions[0]!;
  const choice = answer.data.answers[0]!;
  if (
    item.id !== choice.id ||
    item.multiSelect ||
    choice.selected.length !== 1 ||
    choice.custom ||
    !item.options?.some((o) => o.label === choice.selected[0])
  )
    return null;
  const requestedConversation = scheduleConversationIntent(request);
  const work = requestedConversation.request.trim().match(timedWork);
  if (!work) return null;
  // Reuse the established quote/condition/negation/multiple-clock checks.
  // This synthetic sentence validates work only; it grants no scheduling right.
  const body = work[3]!.replace(/一次$/u, '').trim();
  if (!body || !explicitOnceTaskIntent(`${work[1]}${work[2]}后执行${body}`))
    return null;
  const label = choice.selected[0]!;
  const selectedConversation = scheduleConversationIntent(label);
  if (
    requestedConversation.conversationMode &&
    selectedConversation.conversationMode &&
    requestedConversation.conversationMode !==
      selectedConversation.conversationMode
  )
    return null;
  const mode =
    selectedConversation.conversationMode ??
    requestedConversation.conversationMode;
  const conversation = mode === undefined ? {} : { conversationMode: mode };
  const selected = selectedConversation.request.match(frequency);
  if (
    !selected ||
    (selected[1] && selected[4]) ||
    (!selected[1] && !selected[4])
  )
    return null;
  const authoritativeRequest = `${request}\n用户已确认的提醒频率：${label}`;
  if (selected[1]) {
    const intent = explicitRecurringTaskIntent(
      `每隔${selected[2]}${selected[3]}提醒我完成本次要求`,
    );
    return intent
      ? {
          kind: 'recurring' as const,
          ...intent,
          authoritativeRequest,
          ...conversation,
        }
      : null;
  }
  const intent = explicitOnceTaskIntent(
    `${selected[2]}${selected[3]}后提醒我完成本次要求`,
  );
  return intent
    ? {
        kind: 'once' as const,
        ...intent,
        authoritativeRequest,
        ...conversation,
      }
    : null;
}
