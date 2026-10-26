import { expect, it } from 'vitest';
import {
  confirmationLabel,
  recurringConfirmationQuestion,
  recurringRuleText,
  sameConfirmationLabel,
} from './recurring-task-confirmation.ts';

it('renders each rule kind exactly, so the selected option names what is enrolled', () => {
  expect(recurringRuleText({ kind: 'every', seconds: 120 })).toBe(
    '每隔 2 分钟',
  );
  expect(recurringRuleText({ kind: 'every', seconds: 7_200 })).toBe(
    '每隔 2 小时',
  );
  expect(recurringRuleText({ kind: 'every', seconds: 86_400 })).toBe(
    '每隔 1 天',
  );
  expect(recurringRuleText({ kind: 'every', seconds: 90 })).toBe('每隔 90 秒');
  expect(
    recurringRuleText(
      { kind: 'daily', time: '09:30:00', timezone: 'Asia/Shanghai' },
      'new_each_run',
    ),
  ).toBe('每天 09:30（Asia/Shanghai），每次新建聊天');
  expect(
    recurringRuleText({
      kind: 'weekly',
      weekdays: [1, 3, 7],
      time: '02:49:43',
      timezone: 'UTC',
    }),
  ).toBe('每周一、三、日 02:49:43（UTC）');
  expect(
    recurringRuleText({
      kind: 'monthly',
      monthDay: 23,
      time: '05:17:00',
      timezone: 'Asia/Shanghai',
    }),
  ).toBe('每月 23 日 05:17（Asia/Shanghai）');
});

it('tolerates copied spacing and width only, never different wording', () => {
  const label = confirmationLabel('每周一、三 09:30（Asia/Shanghai）');
  expect(
    sameConfirmationLabel(label, '确认:每周一,三09:30(Asia/Shanghai)'),
  ).toBe(true);
  expect(sameConfirmationLabel(label, '确认：每周一、三 09:30（UTC）')).toBe(
    false,
  );
  expect(
    sameConfirmationLabel(label, '不要每周一、三 09:30（Asia/Shanghai）'),
  ).toBe(false);
});

it('asks with the human original request and an explicit decline', () => {
  const card = recurringConfirmationQuestion(
    '弄个定时，每 2 分钟提醒我去吃饭',
    {
      kind: 'every',
      seconds: 120,
    },
  );
  expect(card.questions).toHaveLength(1);
  expect(card.questions[0]).toMatchObject({
    id: 'schedule-confirm',
    multi_select: false,
    options: [{ label: '确认：每隔 2 分钟' }, { label: '先不创建' }],
  });
  expect(card.questions[0]!.question).toContain(
    '弄个定时，每 2 分钟提醒我去吃饭',
  );
});
