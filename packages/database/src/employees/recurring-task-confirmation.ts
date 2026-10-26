import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  UserQuestionItemSchema,
  type AutomationConversationMode,
  type RecurringScheduleRule,
  type UserQuestionItem,
} from '@allrice/contracts';
import { askUserQuestionArguments } from './ask-user-question.ts';

const decline = '先不创建';
const weekdayNames = '一二三四五六日';

function clock(time: string) {
  return time.endsWith(':00') ? time.slice(0, 5) : time;
}

function interval(seconds: number) {
  for (const [size, unit] of [
    [86_400, '天'],
    [3_600, '小时'],
    [60, '分钟'],
  ] as const)
    if (seconds % size === 0) return `${seconds / size} ${unit}`;
  return `${seconds} 秒`;
}

const quote = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Server rendering of the exact structured rule and conversation mode. */
export function recurringRuleText(
  rule: RecurringScheduleRule,
  conversationMode?: AutomationConversationMode,
) {
  const at = 'time' in rule ? ` ${clock(rule.time)}（${rule.timezone}）` : '';
  const period =
    rule.kind === 'every'
      ? `每隔 ${interval(rule.seconds)}`
      : rule.kind === 'daily'
        ? '每天'
        : rule.kind === 'weekly'
          ? `每周${rule.weekdays.map((day) => weekdayNames[day - 1]).join('、')}`
          : `每月 ${rule.monthDay} 日`;
  return `${period}${at}，${conversationMode === 'new_each_run' ? '每次新建聊天执行' : '在本聊天中执行'}`;
}

/** The model's structured task, shown in full when it fits on the card. A
 * longer one is not shown, and then only the human's own words will run. */
const shownWork = (prompt: string) => {
  const work = prompt.trim();
  return work.length <= 2_000 ? work : null;
};

/** The whole card is a pure function of the call, so a presented card can be
 * compared with it exactly; nothing is stored. Its id names this exact call
 * content, so several cards can share one question. */
function card(
  request: string,
  prompt: string,
  rule: RecurringScheduleRule,
  conversationMode?: AutomationConversationMode,
) {
  const work = shownWork(prompt);
  const id = createHash('sha256')
    .update(JSON.stringify([request, work, rule, conversationMode ?? 'reuse']))
    .digest('hex')
    .slice(0, 24);
  return UserQuestionItemSchema.parse({
    id: `schedule-confirm:${id}`,
    header: '确认定时任务',
    question: [
      '要创建这个定时任务吗？',
      work
        ? `每次到点执行：「${work}」\n你的原话：「${quote(request, 600)}」`
        : `每次到点按你的原话执行：「${quote(request, 600)}」`,
      '创建后可在左侧“自动化任务”里暂停或删除。',
    ].join('\n'),
    multiSelect: false,
    options: [
      { label: `确认：${recurringRuleText(rule, conversationMode)}` },
      { label: decline },
    ],
  });
}

export function recurringConfirmationQuestion(
  request: string,
  prompt: string,
  rule: RecurringScheduleRule,
  conversationMode?: AutomationConversationMode,
) {
  return askUserQuestionArguments(
    card(request, prompt, rule, conversationMode),
  );
}

/** A model-written question never confirms, even with the same option words:
 * only the server's own card for exactly this call counts. Declining that
 * card is final for this call content. */
export function recurringConfirmation(
  request: string,
  prompt: string,
  rule: RecurringScheduleRule,
  conversationMode: AutomationConversationMode | undefined,
  answers: readonly { item: UserQuestionItem; label: string }[],
) {
  const expected = card(request, prompt, rule, conversationMode);
  const answer = answers.find(({ item }) => item.id === expected.id);
  if (answer?.label === decline) return 'declined' as const;
  return answer &&
    isDeepStrictEqual(answer.item, expected) &&
    answer.label === expected.options![0]!.label
    ? ('confirmed' as const)
    : null;
}

/** What is stored and runs each time after a confirmation: the human's
 * message plus exactly what the card showed. */
export function confirmedRecurringRequest(
  request: string,
  prompt: string,
  rule: RecurringScheduleRule,
  conversationMode?: AutomationConversationMode,
) {
  const work = shownWork(prompt);
  return [
    request,
    ...(work ? [`用户已确认的任务内容：${work}`] : []),
    `用户已确认的频率：${recurringRuleText(rule, conversationMode)}`,
  ].join('\n');
}
