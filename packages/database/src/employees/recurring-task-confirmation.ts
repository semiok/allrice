import {
  UserQuestionItemSchema,
  type AutomationConversationMode,
  type RecurringScheduleRule,
} from '@allrice/contracts';
import { askUserQuestionArguments } from './ask-user-question.ts';

export const recurringConfirmationQuestionId = 'schedule-confirm';
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

/** Server rendering of the exact structured rule. It is shown as the option a
 * human must select, so the selected words always describe what is enrolled. */
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
  return `${period}${at}${conversationMode === 'new_each_run' ? '，每次新建聊天' : ''}`;
}

export const confirmationLabel = (period: string) => `确认：${period}`;

/** Labels differ only in spacing or full/half-width punctuation the model may
 * normalize when it copies them. Wording itself is never interpreted. */
export function sameConfirmationLabel(a: string, b: string) {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .replace(/\s+/gu, '')
      .replaceAll('，', ',')
      .replaceAll('、', ',');
  return normalize(a) === normalize(b);
}

export function recurringConfirmationQuestion(
  request: string,
  rule: RecurringScheduleRule,
  conversationMode?: AutomationConversationMode,
) {
  const work = request.length > 600 ? `${request.slice(0, 600)}…` : request;
  return askUserQuestionArguments(
    UserQuestionItemSchema.parse({
      id: recurringConfirmationQuestionId,
      header: '确认定时任务',
      question: `要按下面的频率创建定时任务吗？每次到点都会按你的原话执行：\n「${work}」\n创建后可在左侧“自动化任务”里暂停或删除。`,
      multiSelect: false,
      options: [
        { label: confirmationLabel(recurringRuleText(rule, conversationMode)) },
        { label: decline },
      ],
    }),
  );
}
